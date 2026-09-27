// Serve Stipple Forge frontend through TokenArt server
const STIPPLE_FORGE_DIR = '/home/shaun/stipple-forge/frontend';

// Add route for Stipple Forge
app.use('/stipple', express.static(STIPPLE_FORGE_DIR));