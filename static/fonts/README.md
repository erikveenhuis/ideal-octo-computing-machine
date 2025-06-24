# Font Setup for SVG Export

This directory contains .otf font files that will be embedded into SVG exports to ensure proper font rendering.

## Adding Your Fonts

1. **Place your .otf font files in this directory**
   ```
   static/fonts/
   ├── YourFont-Regular.otf
   ├── YourFont-Bold.otf
   ├── YourFont-Light.otf
   └── YourFont-Medium.otf
   ```

2. **Configure font mappings in `font-manager.js`**
   
   Open `static/js/components/font-manager.js` and update the `setupDefaultMappings()` method:
   
   ```javascript
   setupDefaultMappings() {
       // Map Mapbox font names to your actual font files
       this.fontMappings.set('Your Font Regular', 'YourFont-Regular.otf');
       this.fontMappings.set('Your Font Bold', 'YourFont-Bold.otf');
       this.fontMappings.set('Your Font Light', 'YourFont-Light.otf');
       this.fontMappings.set('Your Font Medium', 'YourFont-Medium.otf');
   }
   ```

## How to Find Mapbox Font Names

1. **Check your Mapbox Studio style** - Look at text layers to see what font names are used
2. **Inspect in browser** - Export an SVG and check the console logs for font names
3. **Use browser dev tools** - Inspect text elements on your map to see the `text-font` property

## Example Mapbox Font Names

Common Mapbox font names include:
- `Open Sans Regular`
- `Open Sans Bold`
- `Roboto Regular`
- `Noto Sans Regular`
- `Source Sans Pro Regular`

## Font File Requirements

- **Format**: .otf (OpenType Font) files only
- **Naming**: Use descriptive names that include weight (Regular, Bold, Light, etc.)
- **Size**: Keep font files reasonably sized for web use (< 1MB per file)

## Testing Your Setup

1. Add your font files to this directory
2. Update the font mappings in `font-manager.js`
3. Export an SVG from your map
4. Check the browser console for font loading messages
5. Open the SVG file - fonts should render correctly

## Troubleshooting

- **Console errors about missing fonts**: Check that your .otf files are in the right location
- **Fonts not loading**: Verify the Mapbox font name matches your mapping exactly
- **SVG shows default fonts**: Ensure your font mappings are correct and the .otf files are accessible

## Current Font Mappings

The system currently includes mappings for your DIN Pro fonts:

**Primary DIN Pro variants:**
- `DIN Pro Regular` → `dinpro.otf`
- `DIN Pro Medium` → `dinpro_medium.otf`
- `DIN Pro Italic` → `dinpro_italic.otf`
- `DIN Pro Bold` → `dinpro_bold.otf`

**Additional variants available:**
- `DIN Pro Light` → `dinpro_light.otf`
- `DIN Pro Black` → `dinpro_black.otf`
- `DIN Pro Bold Italic` → `dinpro_bolditalic.otf`
- `DIN Pro Medium Italic` → `dinpro_mediumitalic.otf`
- `DIN Pro Black Italic` → `dinpro_blackitalic.otf`

**Condensed variants:**
- `DIN Pro Condensed Regular` → `dinpro_condensedregular.otf`
- `DIN Pro Condensed Medium` → `dinpro_condensedmedium.otf`
- `DIN Pro Condensed Bold` → `dinpro_condensedbold.otf`
- And many more condensed variants...

These mappings match the font files in your `DIN Pro/` directory.

## Font Quality Improvements

The SVG export now includes several enhancements for better font rendering:

### ✨ **Enhanced Font Smoothness**
- Added `text-rendering="geometricPrecision"` for crisp vector text
- Added `shape-rendering="geometricPrecision"` for precise rendering
- Added antialiasing CSS properties for smoother appearance
- Text now appears much closer to the canvas quality

### 📝 **Smart Text Wrapping Support**
- Automatically detects Mapbox `text-max-width` and `text-line-height` properties
- **Intelligent wrapping**: Only wraps text when appropriate (respects Mapbox intent)
- Wraps long place names like "ROTTERDAM-NOORD" into multiple lines
- **Prevents over-wrapping**: Single-word place names like "AFRIKAANDERWIJK" stay intact
- Uses proper SVG `<tspan>` elements for multi-line text
- Maintains proper line spacing and centering

### 🔍 **Debug Information**
When exporting, check the browser console for:
- `🔤 DETECTED MAPBOX FONT: [Font Name]` - Shows detected fonts
- `🔍 WRAP CHECK "Place Name": ... → WRAP/NO WRAP` - Shows wrapping decisions
- `📝 WRAPPED TEXT: "Long Text" → 2 lines` - Shows actual text wrapping
- `🏷️ RENDERED LINE LABEL: "Text" at x, y` - Shows label positioning
- `⚠️ Cannot wrap "Text" nicely, keeping as single line` - Shows avoided bad wrapping

### 🎯 **Enhanced Target Label Logging**
For specific test labels (both wrapping and non-wrapping cases), you'll see:
- `🎯 TARGET LABEL FOUND: "Label Name"` - Identifies target labels
- `📊 LABEL PROPERTIES:` - Complete property dump including layout, paint, etc.
- `🎯 DETAILED WRAP ANALYSIS:` - Detailed breakdown of wrapping logic:
  - `layerId` - The Mapbox layer identifier  
  - `hasLineHeight` - Whether text-line-height indicates multi-line intent
  - `hasMaxWidth` - Whether text-max-width is set (key wrapping indicator)
  - `textAnchor` - The anchor point (bottom/top = multi-line intent)
  - `anchorIndicatesWrapping` - Whether the anchor suggests multi-line positioning
  - `hasNaturalBreaks` - Whether text has spaces or hyphens for breaking
  - Final wrapping decision (much simpler logic now!)

This helps identify exactly why certain labels aren't wrapping properly.

### 🔬 **Comparative Analysis**
The system now analyzes both:
- **Labels that SHOULD wrap**: Rotterdam-Noord, Park 16Hoven, Oude Westen, etc.
- **Control cases that should NOT wrap**: Noordereiland, Feijnoord

By comparing their properties, we can identify the true Mapbox indicators for text wrapping intent. Look for patterns in `textAnchor`, `textMaxWidth`, and other properties between the two groups.

Your exported SVGs should now have:
- ✅ Proper DIN Pro font rendering (no fallback to Arial)
- ✅ Smooth, crisp text appearance
- ✅ Correctly wrapped multi-line place names
- ✅ Text that matches your map canvas exactly 