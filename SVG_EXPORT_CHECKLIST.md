# SVG Export Fix Checklist

## 🏝️ **1. Islands missing in export** ✅ FIXED
- [ ] Fix island polygon geometry not being captured in SVG export
- [ ] Islands are visible on map but only labels export, not the landmass shapes

## 🔤 **2. Fonts** ✅ FULLY IMPLEMENTED  
- [x] Fix font rendering in SVG exports with proper .otf font embedding
- [x] Create FontManager class for font handling
- [x] Add base64 font embedding in SVG exports 
- [x] Add font mapping system for Mapbox font names
- [x] Add font detection logging to help users identify their fonts
- [x] Improve font smoothness with geometricPrecision and antialiasing
- [x] Add smart text wrapping support to match Mapbox text-max-width behavior
- [x] Handle multi-line text with proper tspan elements
- [x] Fix over-aggressive text wrapping (intelligent wrapping based on layer properties)
- [x] **FIX APPLIED**: Text wrapping logic now uses text_anchor property (bottom/top = multi-line intent)
- [x] **IMPROVED**: Simplified logic - no arbitrary thresholds, follows Mapbox's own indicators
- [x] **ANALYSIS**: Added control cases (Noordereiland, Feijnoord) to compare properties

## 🎨 **3. More styles**
- [ ] Ensure style consistency across different Mapbox styles

## 🧹 **4. Clean-up console logs**
- [ ] Remove unnecessary verbose logging