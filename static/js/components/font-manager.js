/**
 * Font Manager
 * Handles embedding .otf fonts into SVG exports and provides accurate text
 * measurement via the browser's Canvas 2D API once the fonts are loaded.
 */
class FontManager {
    constructor() {
        this.fontCache = new Map();
        this.fontMappings = new Map();
        this._loadedDocumentFonts = new Set(); // family|weight|style keys
        this._measureCanvas = null;
        this._measureCtx = null;
        this.setupDefaultMappings();
    }

    /**
     * Setup default font mappings from Mapbox font names to file names
     * This maps the font names used in Mapbox styles to actual font files
     */
    setupDefaultMappings() {
        // DIN Pro font mappings for your Mapbox styles
        this.fontMappings.set('DIN Pro Regular', 'DIN Pro/dinpro.otf');
        this.fontMappings.set('DIN Pro Medium', 'DIN Pro/dinpro_medium.otf');
        this.fontMappings.set('DIN Pro Italic', 'DIN Pro/dinpro_italic.otf');
        this.fontMappings.set('DIN Pro Bold', 'DIN Pro/dinpro_bold.otf');
        
        // Additional DIN Pro variants available if needed
        this.fontMappings.set('DIN Pro Light', 'DIN Pro/dinpro_light.otf');
        this.fontMappings.set('DIN Pro Black', 'DIN Pro/dinpro_black.otf');
        this.fontMappings.set('DIN Pro Bold Italic', 'DIN Pro/dinpro_bolditalic.otf');
        this.fontMappings.set('DIN Pro Medium Italic', 'DIN Pro/dinpro_mediumitalic.otf');
        this.fontMappings.set('DIN Pro Black Italic', 'DIN Pro/dinpro_blackitalic.otf');
        
        // Condensed variants
        this.fontMappings.set('DIN Pro Condensed Regular', 'DIN Pro/dinpro_condensedregular.otf');
        this.fontMappings.set('DIN Pro Condensed Medium', 'DIN Pro/dinpro_condensedmedium.otf');
        this.fontMappings.set('DIN Pro Condensed Bold', 'DIN Pro/dinpro_condensedbold.otf');
        this.fontMappings.set('DIN Pro Condensed Light', 'DIN Pro/dinpro_condensedlight.otf');
        this.fontMappings.set('DIN Pro Condensed Black', 'DIN Pro/dinpro_condensedblack.otf');
        this.fontMappings.set('DIN Pro Condensed Italic', 'DIN Pro/dinpro_condenseditalic.otf');
        this.fontMappings.set('DIN Pro Condensed Bold Italic', 'DIN Pro/dinpro_condensedbolditalic.otf');
        this.fontMappings.set('DIN Pro Condensed Medium Italic', 'DIN Pro/dinpro_condensedmediumitalic.otf');
        this.fontMappings.set('DIN Pro Condensed Light Italic', 'DIN Pro/dinpro_condensedlightitalic.otf');
        this.fontMappings.set('DIN Pro Condensed Black Italic', 'DIN Pro/dinpro_condensedblackitalic.otf');
    }

    /**
     * Add a custom font mapping
     */
    addFontMapping(mapboxName, filename) {
        this.fontMappings.set(mapboxName, filename);
    }

    /**
     * Load a font file and convert it to base64
     */
    async loadFontAsBase64(fontPath) {
        if (this.fontCache.has(fontPath)) {
            return this.fontCache.get(fontPath);
        }

        try {
            const response = await fetch(fontPath);
            if (!response.ok) {
                console.warn(`Could not load font file: ${fontPath}`);
                return null;
            }

            const arrayBuffer = await response.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            
            // Convert to base64
            let binary = '';
            for (let i = 0; i < uint8Array.byteLength; i++) {
                binary += String.fromCharCode(uint8Array[i]);
            }
            const base64 = btoa(binary);
            
            this.fontCache.set(fontPath, base64);
            return base64;
        } catch (error) {
            console.warn(`Error loading font ${fontPath}:`, error);
            return null;
        }
    }

    /**
     * Get font family name from Mapbox font names.
     *
     * Strips trailing weight/style tokens iteratively so multi-token suffixes
     * like "Bold Italic" or "Medium Italic" are removed without dropping
     * meaningful family modifiers like "Condensed".
     *   "DIN Pro Bold"            -> "DIN Pro"
     *   "DIN Pro Bold Italic"     -> "DIN Pro"
     *   "DIN Pro Condensed Bold"  -> "DIN Pro Condensed"
     */
    extractFontFamily(mapboxFontNames) {
        if (!Array.isArray(mapboxFontNames) || mapboxFontNames.length === 0) {
            return null;
        }

        let name = mapboxFontNames[0];
        const trailingToken = /\s+(Italic|Oblique|Regular|Light|Medium|Bold|Black|Thin|Heavy|Hairline|SemiBold|ExtraBold|UltraBold|ExtraLight|UltraLight|DemiBold|Demi)$/i;

        let previous;
        do {
            previous = name;
            name = name.replace(trailingToken, '');
        } while (name !== previous);

        return name.trim();
    }

    /**
     * Get font weight from a Mapbox text-font entry.
     *
     * Mapbox font arrays are [primary, ...fallbacks]; the primary name is the
     * authoritative one. Fallbacks like "Arial Unicode MS Bold" frequently end
     * in "Bold" regardless of the primary's actual weight, so scanning the
     * joined string yields false positives (e.g. a "DIN Pro Medium" label
     * being reported as bold). Match only against the primary name and check
     * the more specific tokens before generic ones (extrabold/semibold before
     * bold, extralight before light) so all weights resolve correctly.
     */
    extractFontWeight(mapboxFontNames) {
        if (!Array.isArray(mapboxFontNames) || mapboxFontNames.length === 0) {
            return '400';
        }

        const primary = (mapboxFontNames[0] || '').toLowerCase();

        if (/extra\s*bold|ultra\s*bold/.test(primary)) return '800';
        if (/semi\s*bold|demi\s*bold/.test(primary)) return '600';
        if (/extra\s*light|ultra\s*light/.test(primary)) return '200';
        if (primary.includes('black') || primary.includes('heavy')) return '900';
        if (primary.includes('bold')) return '700';
        if (primary.includes('medium')) return '500';
        if (primary.includes('light')) return '300';
        if (primary.includes('thin') || primary.includes('hairline')) return '100';

        return '400';
    }

    /**
     * Get font style (italic vs normal) from a Mapbox text-font entry.
     */
    extractFontStyle(mapboxFontNames) {
        if (!Array.isArray(mapboxFontNames) || mapboxFontNames.length === 0) {
            return 'normal';
        }
        const primary = (mapboxFontNames[0] || '').toLowerCase();
        return /italic|oblique/.test(primary) ? 'italic' : 'normal';
    }

    /**
     * Generate CSS font-face definitions for SVG
     */
    async generateFontFaceCSS(fontFamilyName, fontWeight, fontStyle, mapboxFontNames) {
        // Find the appropriate font file for this family and weight
        let fontFilename = null;
        
        for (const mapboxName of mapboxFontNames) {
            if (this.fontMappings.has(mapboxName)) {
                fontFilename = this.fontMappings.get(mapboxName);
                break;
            }
        }

        if (!fontFilename) {
            console.warn(`No font mapping found for: ${mapboxFontNames.join(', ')}`);
            return '';
        }

        // Construct font path (assuming fonts are in static/fonts/)
        const fontPath = `/static/fonts/${fontFilename}`;
        const base64Font = await this.loadFontAsBase64(fontPath);
        
        if (!base64Font) {
            return '';
        }

        return `
        @font-face {
            font-family: '${fontFamilyName}';
            font-weight: ${fontWeight};
            font-style: ${fontStyle};
            src: url(data:font/otf;base64,${base64Font}) format('opentype');
        }`;
    }

    /**
     * Generate all necessary font definitions for an SVG.
     *
     * Deduplicates by the (family, weight, style) tuple so that, for example,
     * "DIN Pro Bold" and "DIN Pro Black" don't both end up declared as
     * font-weight: bold (the previous behaviour caused a CSS-spec last-wins
     * collision where heavier glyphs were silently replaced by lighter ones).
     */
    async generateSVGFontDefinitions(usedFonts) {
        const seen = new Set();
        const fontDefinitions = [];

        for (const fontInfo of usedFonts) {
            const { mapboxFontNames } = fontInfo;
            const fontFamily = this.extractFontFamily(mapboxFontNames);
            const fontWeight = this.extractFontWeight(mapboxFontNames);
            const fontStyle = this.extractFontStyle(mapboxFontNames);

            if (!fontFamily) continue;

            const key = `${fontFamily}|${fontWeight}|${fontStyle}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const fontFaceCSS = await this.generateFontFaceCSS(fontFamily, fontWeight, fontStyle, mapboxFontNames);
            if (fontFaceCSS) {
                fontDefinitions.push(fontFaceCSS);
            }
        }

        if (fontDefinitions.length === 0) {
            return '';
        }

        return `
  <defs>
    <style type="text/css"><![CDATA[
      ${fontDefinitions.join('\n')}
    ]]></style>
  </defs>`;
    }

    /**
     * Process Mapbox font names for SVG use
     */
    processMapboxFonts(mapboxFontNames) {
        if (!Array.isArray(mapboxFontNames) || mapboxFontNames.length === 0) {
            return {
                fontFamily: 'Arial, sans-serif',
                fontWeight: '400',
                fontStyle: 'normal'
            };
        }

        const fontFamily = this.extractFontFamily(mapboxFontNames);
        const fontWeight = this.extractFontWeight(mapboxFontNames);
        const fontStyle = this.extractFontStyle(mapboxFontNames);

        // If we have a custom font family, use it; otherwise fall back to web-safe fonts
        const finalFontFamily = fontFamily ? `'${fontFamily}', Arial, sans-serif` : 'Arial, sans-serif';

        return {
            fontFamily: finalFontFamily,
            fontWeight: fontWeight,
            fontStyle: fontStyle,
            // Pure family name without quotes/fallbacks for canvas measureText
            measureFontFamily: fontFamily ? `'${fontFamily}'` : 'Arial, sans-serif'
        };
    }

    /**
     * Load a font into the document so canvas 2D measureText can measure
     * glyph widths accurately. Idempotent per (family,weight,style) key.
     */
    async ensureFontInDocument(mapboxFontNames) {
        if (!Array.isArray(mapboxFontNames) || mapboxFontNames.length === 0) {
            return false;
        }
        const family = this.extractFontFamily(mapboxFontNames);
        const weight = this.extractFontWeight(mapboxFontNames);
        const style = this.extractFontStyle(mapboxFontNames);
        if (!family) return false;

        const key = `${family}|${weight}|${style}`;
        if (this._loadedDocumentFonts.has(key)) return true;

        let filename = null;
        for (const name of mapboxFontNames) {
            if (this.fontMappings.has(name)) {
                filename = this.fontMappings.get(name);
                break;
            }
        }
        if (!filename) return false;

        const fontPath = `/static/fonts/${filename}`;
        const base64 = await this.loadFontAsBase64(fontPath);
        if (!base64) return false;

        if (!('FontFace' in window) || !document.fonts || !document.fonts.add) {
            // Browser without FontFace API support; mark as "tried" to avoid retrying.
            this._loadedDocumentFonts.add(key);
            return false;
        }

        try {
            const fontFace = new FontFace(family, `url(data:font/otf;base64,${base64}) format('opentype')`, {
                weight: String(weight),
                style: style
            });
            await fontFace.load();
            document.fonts.add(fontFace);
            this._loadedDocumentFonts.add(key);
            return true;
        } catch (err) {
            console.warn(`Could not register font ${family} ${weight} ${style}:`, err);
            this._loadedDocumentFonts.add(key);
            return false;
        }
    }

    /**
     * Load every font we'll need for the export so subsequent measureText calls
     * are accurate. Accepts the same objects we pushed into FeatureConverter.usedFonts.
     */
    async ensureAllFontsInDocument(usedFonts) {
        if (!usedFonts || usedFonts.length === 0) return;
        const tasks = [];
        for (const fontInfo of usedFonts) {
            if (fontInfo && fontInfo.mapboxFontNames) {
                tasks.push(this.ensureFontInDocument(fontInfo.mapboxFontNames));
            }
        }
        await Promise.all(tasks);
        if (document.fonts && typeof document.fonts.ready?.then === 'function') {
            await document.fonts.ready;
        }
    }

    /**
     * Measure the rendered pixel width of `text` for a given font specification.
     *
     * letterSpacingEm is Mapbox's text-letter-spacing in em units (default 0).
     * It's added to the measured width as (chars - 1) * letterSpacingEm *
     * fontSize, which matches how Mapbox lays out characters with extra
     * tracking. This is the primary reason "ROTTERDAM-NOORD" / "OUDE WESTEN"
     * style neighbourhood labels were not wrapping in the export: Mapbox
     * commonly applies ~0.1 em letter spacing to those layers, and without
     * accounting for it, our measured width is far too narrow.
     */
    measureTextWidth(text, fontFamily, fontSize, fontWeight = '400', fontStyle = 'normal', letterSpacingEm = 0) {
        if (!text) return 0;
        if (!this._measureCanvas) {
            this._measureCanvas = document.createElement('canvas');
            this._measureCtx = this._measureCanvas.getContext('2d');
        }
        const ctx = this._measureCtx;
        const fontSpec = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
        if (ctx.font !== fontSpec) {
            ctx.font = fontSpec;
        }
        const baseWidth = ctx.measureText(text).width;
        const trackingChars = Math.max(0, text.length - 1);
        const tracking = trackingChars * (letterSpacingEm || 0) * fontSize;
        return baseWidth + tracking;
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = FontManager;
} 