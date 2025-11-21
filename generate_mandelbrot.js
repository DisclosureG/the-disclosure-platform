import fs from 'fs';

const width = 400;
const height = 400;
const maxIter = 100;
const xMin = -2.0;
const xMax = 0.6;
const yMin = -1.2;
const yMax = 1.2;

function mandelbrot(c_re, c_im) {
    let x = 0, y = 0;
    let x2 = 0, y2 = 0;
    let iter = 0;
    while (x2 + y2 <= 4 && iter < maxIter) {
        y = 2 * x * y + c_im;
        x = x2 - y2 + c_re;
        x2 = x * x;
        y2 = y * y;
        iter++;
    }
    return iter;
}

// We will generate paths for different iteration counts to create "layers"
// This is a simple way to vectorize: just create small rects for now, or better, circles.
// To keep file size low, we'll use a lower resolution for the "aura" and higher for the set.

let svgContent = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
<defs>
  <filter id="glow">
    <feGaussianBlur stdDeviation="1.5" result="coloredBlur"/>
    <feMerge>
      <feMergeNode in="coloredBlur"/>
      <feMergeNode in="SourceGraphic"/>
    </feMerge>
  </filter>
</defs>
<rect width="100%" height="100%" fill="transparent" />
`;

// Generate the set (black/dark)
let setPath = "";
// We'll simple iterate pixels. If it's in the set, we draw a pixel (rect).
// Optimization: run-length encoding for horizontal lines?
// Or just use a path with M and h commands.

const pixelSize = 1; // Resolution

for (let py = 0; py < height; py += pixelSize) {
    let currentRunStart = -1;
    let y = yMin + (py / height) * (yMax - yMin);

    for (let px = 0; px < width; px += pixelSize) {
        let x = xMin + (px / width) * (xMax - xMin);
        let m = mandelbrot(x, y);

        if (m === maxIter) {
            if (currentRunStart === -1) currentRunStart = px;
        } else {
            if (currentRunStart !== -1) {
                // End of run, add rect
                setPath += `M${currentRunStart},${py}h${px - currentRunStart}v${pixelSize}h-${px - currentRunStart}z `;
                currentRunStart = -1;
            }
        }
    }
    if (currentRunStart !== -1) {
        setPath += `M${currentRunStart},${py}h${width - currentRunStart}v${pixelSize}h-${width - currentRunStart}z `;
    }
}

svgContent += `<path d="${setPath}" fill="#000" stroke="none" />`;

// Generate "aura" layers for trippy effect
// We'll pick a few iteration thresholds
const thresholds = [10, 20, 40, 80];
const colors = ["#ff00ff", "#00ffff", "#ffff00", "#00ff00"];

thresholds.forEach((thresh, idx) => {
    let layerPath = "";
    // Lower resolution for aura to save space and give a "digital" look
    const auraPixelSize = 2;

    for (let py = 0; py < height; py += auraPixelSize) {
        let currentRunStart = -1;
        let y = yMin + (py / height) * (yMax - yMin);

        for (let px = 0; px < width; px += auraPixelSize) {
            let x = xMin + (px / width) * (xMax - xMin);
            let m = mandelbrot(x, y);

            // If it escaped between this threshold and the next (or max)
            let nextThresh = thresholds[idx + 1] || maxIter;
            if (m >= thresh && m < nextThresh) {
                if (currentRunStart === -1) currentRunStart = px;
            } else {
                if (currentRunStart !== -1) {
                    layerPath += `M${currentRunStart},${py}h${px - currentRunStart}v${auraPixelSize}h-${px - currentRunStart}z `;
                    currentRunStart = -1;
                }
            }
        }
        if (currentRunStart !== -1) {
            layerPath += `M${currentRunStart},${py}h${width - currentRunStart}v${auraPixelSize}h-${width - currentRunStart}z `;
        }
    }

    svgContent += `<path d="${layerPath}" fill="${colors[idx % colors.length]}" fill-opacity="0.6" stroke="none" filter="url(#glow)" />`;
});


svgContent += `</svg>`;

fs.writeFileSync('public/artefacts/mandelbrot.svg', svgContent);
console.log('Mandelbrot SVG generated');
