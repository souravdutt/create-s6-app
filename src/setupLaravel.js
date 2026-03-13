#!/usr/bin/env node

/**
 * setupLaravel.js
 * ------------------------------------
 * A one-command Laravel installer that works anywhere using Node.
 * Hybrid mode: Downloads PHP + Composer binaries automatically
 * from your GitHub repo releases.
 */

import os from "os";
import fs from "fs";
import https from "https";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import * as tar from "tar";
import AdmZip from "adm-zip";
import ora from "ora";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------- CONFIG ----------------
const RELEASE = "8.4.14"; // 🔢 change when PHP version updates
const BIN_DIR = path.resolve("./bin");
const IS_WINDOWS = os.platform() === "win32";
const PHP_BIN = path.join(BIN_DIR, IS_WINDOWS ? "php.exe" : "php");
const COMPOSER_BIN = path.join(BIN_DIR, "composer.phar");
const BASE_URL = `https://github.com/souravdutt/php-binaries/releases/download/${RELEASE}`;
// Official PHP Windows release: includes php8.dll and all required DLLs (php8.dll is required by php.exe)
const PHP_WIN_URL = `https://windows.php.net/downloads/releases/php-${RELEASE}-nts-Win32-vs17-x64.zip`;
const COMPOSER_URL = "https://github.com/souravdutt/php-binaries/raw/main/composer/2.8.12/composer.phar";

// ---------------- UTILS ----------------
const log = (msg) => console.log(`\x1b[36m${msg}\x1b[0m`);
const error = (msg) => console.error(`\x1b[31m${msg}\x1b[0m`);

function run(cmd, cwd = process.cwd()) {
  execSync(cmd, { stdio: "inherit", cwd });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Download file using Node.js https module with progress indicator
async function downloadFile(url, dest, label = "Downloading") {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    
    https.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 302 || response.statusCode === 301) {
        file.close(() => {
          downloadFile(response.headers.location, dest, label).then(resolve).catch(reject);
        });
        return;
      }

      // Reject on HTTP errors
      if (response.statusCode !== 200) {
        file.close(() => {
          if (fs.existsSync(dest)) fs.unlinkSync(dest);
          reject(new Error(`HTTP ${response.statusCode} while downloading ${url}`));
        });
        return;
      }
      
      const totalSize = parseInt(response.headers['content-length'], 10);
      let downloadedSize = 0;
      const spinner = ora(`${label} 0%`).start();
      
      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        
        if (totalSize) {
          const percentage = ((downloadedSize / totalSize) * 100).toFixed(1);
          const downloadedMB = (downloadedSize / 1024 / 1024).toFixed(1);
          const totalMB = (totalSize / 1024 / 1024).toFixed(1);
          spinner.text = `${label} ${percentage}% (${downloadedMB} MB / ${totalMB} MB)`;
        } else {
          const downloadedMB = (downloadedSize / 1024 / 1024).toFixed(1);
          spinner.text = `${label} ${downloadedMB} MB`;
        }
      });
      
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        spinner.succeed(`${label} complete!`);
        resolve();
      });
    }).on('error', (err) => {
      file.close(() => {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        reject(err);
      });
    });
  });
}

// ---------------- DETECT OS ----------------
function detectPlatform() {
  const platform = os.platform();
  if (platform === "win32") return { os: "win", ext: "zip" };
  if (platform === "darwin") return { os: "mac", ext: "tar.gz" };
  return { os: "linux", ext: "tar.gz" };
}

// ---------------- DOWNLOAD + EXTRACT ----------------
function getBinaryFilename({ os, ext }) {
  return os === "win" ? "php-win.zip" : `php-${os}.${ext}`;
}

async function setupBinaries() {
  ensureDir(BIN_DIR);
  const { os, ext } = detectPlatform();
  const filename = getBinaryFilename({ os, ext });
  // Use official PHP Windows distribution for Windows (includes php8.dll and all required DLLs).
  // The php-binaries custom zip only contains the thin php.exe launcher without php8.dll.
  const url = IS_WINDOWS ? PHP_WIN_URL : `${BASE_URL}/${filename}`;

  if (!fs.existsSync(PHP_BIN)) {
    const archivePath = path.join(BIN_DIR, filename);
    await downloadFile(url, archivePath, `Downloading PHP binary for ${os}`);

    const extractSpinner = ora("Extracting PHP binary...").start();

    if (ext === "zip") {
      // Use adm-zip for Windows
      const zip = new AdmZip(archivePath);
      zip.extractAllTo(BIN_DIR, true);
    } else {
      // Use tar for Unix-like systems
      await tar.x({
        file: archivePath,
        cwd: BIN_DIR,
      });
    }

    // Find PHP binary path
    const phpCandidates = fs
      .readdirSync(BIN_DIR)
      .filter((f) => f.startsWith("php") && !f.endsWith(".gz") && !f.endsWith(".zip"));

    const phpFile = phpCandidates.find((f) =>
      os === "win" ? f === "php.exe" : !f.includes("fpm")
    );
    
    if (!phpFile) {
      extractSpinner.fail("PHP binary not found after extraction!");
      process.exit(1);
    }
    
    const phpPath = path.join(BIN_DIR, phpFile);
    // Only rename if source and destination are different (e.g. php-8.4.14-linux → php)
    if (phpPath !== PHP_BIN) {
      fs.renameSync(phpPath, PHP_BIN);
    }
    fs.chmodSync(PHP_BIN, 0o755);
    extractSpinner.succeed("PHP binary extracted!");
  } else {
    const skipSpinner = ora("PHP binaries already exist").succeed();
  }

  if (!fs.existsSync(COMPOSER_BIN)) {
    // Download Composer
    await downloadFile(COMPOSER_URL, COMPOSER_BIN, "Downloading Composer");
    fs.chmodSync(COMPOSER_BIN, 0o755);
  } else {
    const skipSpinner = ora("Composer binary already exists").succeed();
  }
}

// ---------------- CREATE LARAVEL APP ----------------
async function createLaravelApp(appName) {
  if (!appName) {
    error("Usage: npx setup-laravel <app-name>");
    process.exit(1);
  }

  const targetDir = path.resolve(process.cwd(), appName);
  if (fs.existsSync(targetDir)) {
    error("❌ Directory already exists!");
    process.exit(1);
  }

  ensureDir(targetDir);
  const createSpinner = ora(`Creating Laravel app: ${appName}`).start();

  try {
    run(`${PHP_BIN} ${COMPOSER_BIN} create-project laravel/laravel ${targetDir}`);
    createSpinner.succeed("Laravel project created successfully!");
  } catch (err) {
    createSpinner.fail("Installation failed.");
    console.error(err.message);
    process.exit(1);
  }
}

// ---------------- EXPORTED FUNCTION ----------------
export async function setupLaravel(appName) {
  await setupBinaries();
  await verifyPHP();
  await createLaravelApp(appName);

  // Return paths for further setup
  return {
    projectPath: path.resolve(process.cwd(), appName),
    phpBin: PHP_BIN,
    composerBin: COMPOSER_BIN,
  };
}

// ---------------- VERIFY PHP ----------------
async function verifyPHP() {
  try {
    run(`${PHP_BIN} -v`);
  } catch {
    error("❌ PHP runtime test failed. Check downloaded binary.");
    process.exit(1);
  }

  try {
    run(`${PHP_BIN} ${COMPOSER_BIN} -V`);
  } catch {
    error("❌ Composer test failed. Check downloaded binary.");
    process.exit(1);
  }
}

// ---------------- MAIN EXECUTION ----------------
async function main() {
  const appName = process.argv[2];
  await setupLaravel(appName);

  log(`
✨ All done! Your Laravel app '${appName}' is ready.

👉 Next steps:
   cd ${appName}
   ../bin/php artisan serve

(No system PHP or Composer required 🎉)
`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
