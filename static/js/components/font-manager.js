/**
 * Font Manager
 * Handles embedding .otf fonts into SVG exports
 */
class FontManager {
    constructor() {
        this.fontCache = new Map();
        this.fontMappings = new Map();
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
     * Get font family name from Mapbox font names
     */
    extractFontFamily(mapboxFontNames) {
        if (!Array.isArray(mapboxFontNames) || mapboxFontNames.length === 0) {
            return null;
        }

        // Take the first font name and extract the family name
        const firstName = mapboxFontNames[0];
        
        // Remove weight indicators to get base family name
        return firstName
            .replace(/\s+(Regular|Bold|Light|Medium|Italic|Black|Thin|ExtraLight|SemiBold|ExtraBold)$/i, '')
            .trim();
    }

    /**
     * Get font weight from Mapbox font names
     */
    extractFontWeight(mapboxFontNames) {
        if (!Array.isArray(mapboxFontNames) || mapboxFontNames.length === 0) {
            return 'normal';
        }

        const fontString = mapboxFontNames.join(' ').toLowerCase();
        
        if (fontString.includes('bold')) return 'bold';
        if (fontString.includes('light')) return '300';
        if (fontString.includes('medium')) return '500';
        if (fontString.includes('semibold')) return '600';
        if (fontString.includes('extrabold')) return '800';
        if (fontString.includes('black')) return '900';
        if (fontString.includes('thin')) return '100';
        if (fontString.includes('extralight')) return '200';
        
        return 'normal';
    }

    /**
     * Generate CSS font-face definitions for SVG
     */
    async generateFontFaceCSS(fontFamilyName, fontWeight, mapboxFontNames) {
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
            font-style: normal;
            src: url(data:font/otf;base64,${base64Font}) format('opentype');
        }`;
    }

    /**
     * Generate all necessary font definitions for an SVG
     */
    async generateSVGFontDefinitions(usedFonts) {
        const fontDefinitions = new Set();
        
        for (const fontInfo of usedFonts) {
            const { mapboxFontNames } = fontInfo;
            const fontFamily = this.extractFontFamily(mapboxFontNames);
            const fontWeight = this.extractFontWeight(mapboxFontNames);
            
            if (fontFamily) {
                const fontFaceCSS = await this.generateFontFaceCSS(fontFamily, fontWeight, mapboxFontNames);
                if (fontFaceCSS) {
                    fontDefinitions.add(fontFaceCSS);
                }
            }
        }

        if (fontDefinitions.size === 0) {
            return '';
        }

        return `
  <defs>
    <style type="text/css"><![CDATA[
      ${Array.from(fontDefinitions).join('\n')}
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
                fontWeight: 'normal'
            };
        }

        const fontFamily = this.extractFontFamily(mapboxFontNames);
        const fontWeight = this.extractFontWeight(mapboxFontNames);
        
        // If we have a custom font family, use it; otherwise fall back to web-safe fonts
        const finalFontFamily = fontFamily ? `'${fontFamily}', Arial, sans-serif` : 'Arial, sans-serif';
        
        return {
            fontFamily: finalFontFamily,
            fontWeight: fontWeight
        };
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = FontManager;
} 