"use strict";

// The extension is declared separately in manifest.json. The plugin process
// itself has no tools, commands, filesystem access, or network access.
async function onLoad() {}
async function onUnload() {}

module.exports = { onLoad, onUnload };
