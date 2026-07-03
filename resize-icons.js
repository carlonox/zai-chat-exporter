// resize-icons.js
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const sizes = [16, 19, 32, 48, 96, 128];
const source = "src/icons/icon.png"; // Source icon (1024x1024 recommended)
const outputDir = "src/icons/";

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

async function resizeIcons() {
  console.log("Resizing icons...");

  for (const size of sizes) {
    const output = path.join(outputDir, `icon${size}.png`);
    await sharp(source)
      .trim()
      .resize(size, size, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toFile(output);
    console.log("  " + size + "x" + size + " → " + output);
  }

  // Also copy the source as icon1024.png for store submission
  const originalOutput = path.join(outputDir, "icon1024.png");
  fs.copyFileSync(source, originalOutput);
  console.log("  1024x1024 \u2192 " + originalOutput);

  console.log("Icons ready.");
}

resizeIcons().catch(console.error);
