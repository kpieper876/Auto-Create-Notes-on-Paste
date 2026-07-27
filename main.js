
/* Auto Create Notes on Paste - main.js
 * Plain JS, no build step. Drop into .obsidian/plugins/auto-create-on-paste/
 */
const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  TFile,
  normalizePath,
  parseLinktext,
} = require("obsidian");

const DEFAULT_SETTINGS = {
  createOnPaste: true,
  destinationMode: "fixed", // "fixed" | "same-as-current"
  targetFolder: "_inbox",
  respectLinkPath: true,    // if [[People/Alan Turing]], prefer that folder
  useTemplate: false,
  templatePath: "",         // e.g. "Templates/Note.md"
};

class AutoCreateOnPastePlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.addSettingTab(new AutoCreateOnPasteSettingsTab(this.app, this));

    // Command: scan current file and create all missing wikilinks
    this.addCommand({
      id: "create-missing-wikilinks-in-current-file",
      name: "Create notes for missing wikilinks in current file",
      callback: async () => {
        const view = this.app.workspace.getActiveViewOfType(this.app.plugins.getPlugin("file-explorer")?.constructor?.prototype?.MarkdownView || window.MarkdownView);
        // Fallback: try standard MarkdownView
        const mdView = view || this.app.workspace.getActiveViewOfType(window.MarkdownView);
        if (!mdView || !mdView.file) {
          new Notice("Open a markdown file first.");
          return;
        }
        const text = mdView.editor.getValue();
        const created = await this.processTextForLinks(text, mdView.file.path);
        new Notice(created.length ? `Created ${created.length} note(s).` : "No notes needed.");
      },
    });

    // Create on paste
    if (this.settings.createOnPaste) {
      this.registerEvent(
        this.app.workspace.on("editor-paste", async (evt, editor, mdView) => {
          try {
            const pasted = evt?.clipboardData?.getData("text/plain");
            if (!pasted || !mdView?.file) return;

            // Don't block the paste; run shortly after
            setTimeout(async () => {
              const created = await this.processTextForLinks(pasted, mdView.file.path);
              if (created.length) {
                new Notice(`Auto-created ${created.length} note(s).`);
              }
            }, 10);
          } catch (e) {
            console.error("auto-create-on-paste error:", e);
          }
        })
      );
    }
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ---- Core helpers ----

  // Find all [[wikilinks]] in a chunk of text, return array of {path, alias}
  extractWikiLinks(text) {
    const results = [];
    const regex = /\[\[([^\]]+)\]\]/g;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const inner = m[1].trim();
      if (!inner) continue;
      try {
        const parsed = parseLinktext(inner); // {path, subpath, display}
        const linkPath = (parsed?.path || inner).trim();
        const alias = (parsed?.display || "").trim();
        if (linkPath) {
          results.push({ path: linkPath, alias });
        }
      } catch (e) {
        // Fallback: basic split on pipe
        const [p, a] = inner.split("|");
        results.push({ path: (p || "").trim(), alias: (a || "").trim() });
      }
    }
    return results;
  }

  async processTextForLinks(text, sourcePath) {
    const links = this.extractWikiLinks(text);
    if (!links.length) return [];

    const createdPaths = new Set();
    const created = [];

    for (const { path, alias } of links) {
      const filePath = await this.createNoteIfMissing(path, alias, sourcePath, createdPaths);
      if (filePath) created.push(filePath);
    }
    return created;
  }

  // Create missing note for link path (respecting settings); returns created path or null
  async createNoteIfMissing(linkPath, alias, sourcePath, createdPaths) {
    if (!linkPath) return null;

    // If link resolves to an existing file, skip
    const existing = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
    if (existing instanceof TFile) return null;

    // Determine destination folder & filename
    let folder = "";
    let filename = linkPath;

    if (this.settings.respectLinkPath && linkPath.includes("/")) {
      const idx = linkPath.lastIndexOf("/");
      folder = linkPath.slice(0, idx);
      filename = linkPath.slice(idx + 1);
    } else {
      if (this.settings.destinationMode === "same-as-current") {
        const src = this.app.vault.getAbstractFileByPath(sourcePath);
        folder = (src && src.parent && src.parent.path) ? src.parent.path : "";
      } else {
        folder = (this.settings.targetFolder || "").trim();
      }
    }

    filename = this.sanitizeFileName(filename);
    if (!filename) return null;

    const finalFolder = folder ? normalizePath(folder) : "";
    const finalPath = normalizePath((finalFolder ? finalFolder + "/" : "") + filename + ".md");

    if (createdPaths.has(finalPath)) return null; // already creating in this pass

    // Ensure folder exists
    if (finalFolder) {
      await this.ensureFolderRecursive(finalFolder);
    }

    // Prepare content
    let content = "";
    if (this.settings.useTemplate && this.settings.templatePath) {
      const t = this.app.vault.getAbstractFileByPath(this.settings.templatePath);
      if (t && t instanceof TFile) {
        try {
          let tmpl = await this.app.vault.read(t);
          // Very small token replacement for convenience
          tmpl = tmpl.replace(/\{\{\s*title\s*\}\}/gi, filename);
          tmpl = tmpl.replace(/\{\{\s*alias\s*\}\}/gi, alias || "");
          content = tmpl;
          // If template doesn't have YAML and alias exists, prepend simple YAML
          if (alias && !tmpl.trimStart().startsWith("---")) {
            content = `---\naliases: ["${alias.replace(/"/g, '\\"')}"]\n---\n\n` + content;
          }
        } catch (e) {
          console.warn("Template read failed:", e);
          content = `# ${filename}\n`;
          if (alias) content = `---\naliases: ["${alias.replace(/"/g, '\\"')}"]\n---\n\n` + content;
        }
      } else {
        content = `# ${filename}\n`;
        if (alias) content = `---\naliases: ["${alias.replace(/"/g, '\\"')}"]\n---\n\n` + content;
      }
    } else {
      content = `# ${filename}\n`;
      if (alias) content = `---\naliases: ["${alias.replace(/"/g, '\\"')}"]\n---\n\n` + content;
    }

    try {
      await this.app.vault.create(finalPath, content);
      createdPaths.add(finalPath);
      return finalPath;
    } catch (e) {
      console.error("Failed creating note:", finalPath, e);
      return null;
    }
  }

  sanitizeFileName(name) {
    // Remove illegal filename characters on Windows/macOS
    return name.replace(/[\\/:*?"<>|]/g, "-").trim();
  }

  async ensureFolderRecursive(folderPath) {
    const parts = normalizePath(folderPath).split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      try {
        await this.app.vault.createFolder(cur);
      } catch (e) {
        // already exists
      }
    }
  }
}

class AutoCreateOnPasteSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Auto Create Notes on Paste" });

    new Setting(containerEl)
      .setName("Create on paste")
      .setDesc("Automatically create notes for [[wikilinks]] detected in pasted text.")
      .addToggle((t) => t
        .setValue(this.plugin.settings.createOnPaste)
        .onChange(async (v) => {
          this.plugin.settings.createOnPaste = v;
          await this.plugin.saveSettings();
          new Notice(v ? "Enabled create-on-paste" : "Disabled create-on-paste");
        }));

    new Setting(containerEl)
      .setName("Destination")
      .setDesc("Where to create notes (when the link itself does not include a folder).")
      .addDropdown((d) => d
        .addOption("fixed", "Fixed folder")
        .addOption("same-as-current", "Same folder as current note")
        .setValue(this.plugin.settings.destinationMode)
        .onChange(async (v) => {
          this.plugin.settings.destinationMode = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Fixed folder")
      .setDesc("If Destination is 'Fixed folder', create notes here (e.g. _inbox).")
      .addText((t) => t
        .setPlaceholder("_inbox")
        .setValue(this.plugin.settings.targetFolder)
        .onChange(async (v) => {
          this.plugin.settings.targetFolder = v.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Respect link's folder path")
      .setDesc("If a link includes a folder (e.g., [[People/Alan Turing]]), create the note there instead of the Destination setting.")
      .addToggle((t) => t
        .setValue(this.plugin.settings.respectLinkPath)
        .onChange(async (v) => {
          this.plugin.settings.respectLinkPath = v;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl("h3", { text: "Template (optional)" });

    new Setting(containerEl)
      .setName("Use template")
      .setDesc("Use a template file when creating notes. Supports {{title}} and {{alias}} tokens.")
      .addToggle((t) => t
        .setValue(this.plugin.settings.useTemplate)
        .onChange(async (v) => {
          this.plugin.settings.useTemplate = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Template file path")
      .setDesc("Relative to your vault root, e.g. Templates/Note.md")
      .addText((t) => t
        .setPlaceholder("Templates/Note.md")
        .setValue(this.plugin.settings.templatePath)
        .onChange(async (v) => {
          this.plugin.settings.templatePath = v.trim();
          await this.plugin.saveSettings();
        }));
  }
}

module.exports = AutoCreateOnPastePlugin;

