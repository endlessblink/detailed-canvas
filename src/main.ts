import { Plugin, TFile, Notice, Menu, ItemView, requestUrl } from 'obsidian';
import { DetailedCanvasSettings, AIProvider, CanvasLinkData, EnrichmentResult, CanvasNodeInstance } from './types';
import { DEFAULT_SETTINGS } from './constants';
import { DetailedCanvasSettingTab } from './settings';
import { createProvider } from './services/provider-factory';
import { ScraperService } from './services/scraper';
import { CanvasMonitor } from './canvas/monitor';
import { isValidUrl } from './canvas/utils';
import { organizeCanvas } from './canvas/organizer';

// Module augmentation for internal canvas events
declare module 'obsidian' {
  interface Workspace {
    on(name: 'canvas:node-menu', callback: (menu: Menu, node: CanvasNodeInstance) => void): EventRef;
    on(name: 'canvas:selection-menu', callback: (menu: Menu, canvas: unknown) => void): EventRef;
  }
}

export default class DetailedCanvasPlugin extends Plugin {
  settings!: DetailedCanvasSettings;

  private aiProvider!: AIProvider;
  private scraperService!: ScraperService;
  private canvasMonitor!: CanvasMonitor;
  private processingNodes: Set<string> = new Set(); // Prevent duplicate processing

  async onload() {
    await this.loadSettings();

    // Initialize services
    this.aiProvider = createProvider(this.settings);
    this.scraperService = new ScraperService();

    // Initialize canvas monitor
    this.canvasMonitor = new CanvasMonitor(
      this.app,
      (file, node) => { void this.handleNewLinkNode(file, node); },
      `${this.settings.notesFolder}/images`
    );

    // Start watching if auto-enrich is enabled
    if (this.settings.autoEnrichOnPaste) {
      this.canvasMonitor.startWatching();
    }

    // Register commands
    this.addCommand({
      id: 'enrich-selected-link',
      name: 'Enrich selected link card',
      checkCallback: (checking: boolean) => {
        const canvasView = this.getActiveCanvasView();
        if (!canvasView) return false;

        const selection = this.getSelectedLinkNodes(canvasView);
        if (selection.length === 0) return false;

        if (!checking) {
          void this.enrichSelectedLinks(canvasView);
        }
        return true;
      }
    });

    this.addCommand({
      id: 'enrich-all-links',
      name: 'Enrich all link cards in canvas',
      checkCallback: (checking: boolean) => {
        const canvasFile = this.getActiveCanvasFile();
        if (!canvasFile) return false;

        if (!checking) {
          void this.enrichAllLinksInCanvas(canvasFile);
        }
        return true;
      }
    });

    this.addCommand({
      id: 'organize-canvas',
      name: 'Organize canvas nodes into groups',
      checkCallback: (checking: boolean) => {
        const canvasView = this.getActiveCanvasView();
        const canvasFile = this.getActiveCanvasFile();
        if (!canvasView || !canvasFile) return false;

        if (!checking) {
          void organizeCanvas(this.app, canvasFile, this.aiProvider, this.settings);
        }
        return true;
      }
    });

    // Register context menu for canvas nodes
    // Note: 'canvas:node-menu' is not in the official Obsidian API types, but works in practice
    this.registerEvent(
      this.app.workspace.on('canvas:node-menu', (menu: Menu, node: CanvasNodeInstance) => {
        const nodeData = node.getData?.();
        const isLinkNode = nodeData && nodeData.type === 'link' && typeof nodeData.url === 'string' && isValidUrl(nodeData.url);
        const isTextNodeWithUrl = nodeData && nodeData.type === 'text' && 'text' in nodeData && typeof (nodeData as unknown as { text: string }).text === 'string' && isValidUrl((nodeData as unknown as { text: string }).text.trim());
        if (isLinkNode || isTextNodeWithUrl) {
          menu.addItem((item) => {
            item
              .setTitle('Enrich with AI description')
              .setIcon('sparkles')
              .onClick(() => {
                const canvasFile = this.getActiveCanvasFile();
                if (canvasFile) {
                  let linkData: CanvasLinkData;
                  if (nodeData.type === 'link') {
                    linkData = nodeData as unknown as CanvasLinkData;
                  } else {
                    const textData = nodeData as unknown as { id: string; text: string; x: number; y: number; width: number; height: number };
                    linkData = {
                      id: textData.id, type: 'link', url: textData.text.trim(),
                      x: textData.x, y: textData.y, width: textData.width, height: textData.height,
                    } as CanvasLinkData;
                  }
                  void this.enrichLinkNode(canvasFile, linkData);
                }
              });
          });
        }

      })
    );

    // Register context menu for canvas multi-selection
    // 'canvas:selection-menu' fires when right-clicking with multiple nodes selected
    this.registerEvent(
      this.app.workspace.on('canvas:selection-menu', (menu: Menu) => {
        this.addBatchEnrichMenuItem(menu);
      })
    );

    // Add settings tab
    this.addSettingTab(new DetailedCanvasSettingTab(this.app, this));

    // Add ribbon icon with plugin action menu
    this.addRibbonIcon('layout-grid', 'Detailed Canvas', (evt: MouseEvent) => {
      const menu = new Menu();

      const canvasView = this.getActiveCanvasView();
      const canvasFile = this.getActiveCanvasFile();
      const hasCanvas = !!canvasView && !!canvasFile;

      menu.addItem((item) => {
        item
          .setTitle('Enrich selected cards')
          .setIcon('sparkles')
          .setDisabled(!hasCanvas)
          .onClick(() => {
            if (canvasView) {
              void this.enrichSelectedLinks(canvasView);
            }
          });
      });

      menu.addItem((item) => {
        item
          .setTitle('Enrich all link cards')
          .setIcon('sparkles')
          .setDisabled(!hasCanvas)
          .onClick(() => {
            if (canvasFile) {
              void this.enrichAllLinksInCanvas(canvasFile);
            }
          });
      });

      menu.addSeparator();

      menu.addItem((item) => {
        item
          .setTitle('Organize canvas')
          .setIcon('layout-grid')
          .setDisabled(!hasCanvas)
          .onClick(() => {
            if (canvasFile) {
              void organizeCanvas(this.app, canvasFile, this.aiProvider, this.settings);
            }
          });
      });

      menu.showAtMouseEvent(evt);
    });
  }

  onunload() {
    this.canvasMonitor?.stopWatching();
  }

  // Add "Enrich all selected" to a menu if there are selected link nodes
  private addBatchEnrichMenuItem(menu: Menu): void {
    const canvasView = this.getActiveCanvasView();
    if (!canvasView) return;

    const selectedLinks = this.getSelectedLinkNodes(canvasView);
    if (selectedLinks.length < 1) return;

    menu.addItem((item) => {
      item
        .setTitle(`Enrich ${selectedLinks.length > 1 ? `all selected (${selectedLinks.length})` : 'selected link'}`)
        .setIcon('sparkles')
        .onClick(() => {
          void this.enrichSelectedLinks(canvasView);
        });
    });
  }


  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);

    // Update services with new settings
    this.aiProvider = createProvider(this.settings);

    // Keep images folder in sync with settings
    if (this.canvasMonitor) {
      this.canvasMonitor.imagesFolder = `${this.settings.notesFolder}/images`;
    }

    // Toggle canvas monitoring based on settings
    if (this.settings.autoEnrichOnPaste) {
      this.canvasMonitor?.startWatching();
    } else {
      this.canvasMonitor?.stopWatching();
    }
  }

  // Handle new link node from canvas monitor
  private async handleNewLinkNode(file: TFile, node: CanvasLinkData) {
    if (!this.settings.autoEnrichOnPaste) return;
    if (!isValidUrl(node.url)) return;

    await this.enrichLinkNode(file, node);
  }

  // Main enrichment logic
  async enrichLinkNode(canvasFile: TFile, node: CanvasLinkData): Promise<EnrichmentResult> {
    const nodeKey = `${canvasFile.path}:${node.id}`;

    // Prevent duplicate processing
    if (this.processingNodes.has(nodeKey)) {
      return { success: false, error: 'Already processing' };
    }

    this.processingNodes.add(nodeKey);

    try {
      // Show placeholder text on the card while processing
      await this.updateCanvasNodeText(canvasFile, node.id, `Loading...\n\n${node.url}`);

      if (this.settings.showNotifications) {
        new Notice(`Enriching: ${node.url}`);
      }

      // Step 1: Scrape the URL
      const metadata = await this.scraperService.scrape(node.url);
      if (!metadata) {
        throw new Error('Failed to fetch URL content');
      }

      // Step 2: Generate AI description
      let aiDescription = '';
      try {
        aiDescription = await this.aiProvider.generate(
          this.settings.descriptionPrompt,
          metadata.textContent
        );
      } catch (err) {
        console.warn('AI generation failed, using metadata description:', err);
        aiDescription = metadata.description || 'No description available.';
      }

      // Step 3: Build enriched card text
      const title = metadata.title || new URL(node.url).hostname;
      const desc = aiDescription.substring(0, this.settings.maxDescriptionLength);
      const siteName = metadata.siteName || new URL(node.url).hostname;

      // Download OG image locally to avoid broken remote images (429 rate limits etc.)
      let imageLine = '';
      if (metadata.ogImage) {
        try {
          const localImagePath = await this.downloadImage(metadata.ogImage, node.id);
          if (localImagePath) {
            imageLine = `![[${localImagePath}]]\n\n`;
          }
        } catch {
          // Fallback to remote URL if download fails
          imageLine = `![](${metadata.ogImage})\n\n`;
        }
      }

      const cardText = `${imageLine}## [${title}](${node.url})\n\n${desc}\n\n*${siteName}*`;

      // Compute enriched card dimensions
      const enrichedWidth = 400;
      const enrichedHeight = imageLine ? 400 : 250;

      // Step 4: Update the text node directly on the canvas
      const updated = await this.updateCanvasNodeText(canvasFile, node.id, cardText, enrichedWidth, enrichedHeight);

      if (!updated) {
        throw new Error('Failed to update canvas node');
      }

      if (this.settings.showNotifications) {
        new Notice(`Enriched: ${title}`);
      }

      return { success: true };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('Enrichment failed:', errorMsg);

      if (this.settings.showNotifications) {
        new Notice(`Enrichment failed: ${errorMsg}`);
      }

      return { success: false, error: errorMsg };

    } finally {
      this.processingNodes.delete(nodeKey);
    }
  }

  // Update a canvas node's text content (and optionally size) via file I/O — works on mobile and desktop
  private async updateCanvasNodeText(
    canvasFile: TFile,
    nodeId: string,
    newText: string,
    width?: number,
    height?: number,
  ): Promise<boolean> {
    try {
      await this.app.vault.process(canvasFile, (content) => {
        const canvasData = JSON.parse(content);
        const node = canvasData.nodes?.find((n: { id: string }) => n.id === nodeId);
        if (!node) return content; // Return unchanged if node not found
        node.text = newText;
        node.type = 'text'; // Convert link nodes to text nodes for enrichment
        if (width !== undefined) node.width = Math.max(node.width ?? 0, width);
        if (height !== undefined) node.height = height;
        return JSON.stringify(canvasData, null, '\t');
      });
      return true;
    } catch {
      return false;
    }
  }

  // Reposition a set of node IDs into a non-overlapping grid centred on their original centroid
  private async spreadNodes(canvasFile: TFile, nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return;

    await this.app.vault.process(canvasFile, (content) => {
      const canvasData = JSON.parse(content);
      const allNodes: Array<{ id: string; x: number; y: number; width: number; height: number }> =
        canvasData.nodes ?? [];

      // Collect only the nodes we enriched
      const targets = nodeIds
        .map((id) => allNodes.find((n) => n.id === id))
        .filter((n): n is { id: string; x: number; y: number; width: number; height: number } => n !== undefined);

      if (targets.length === 0) return content;

      // Compute centroid of original positions
      const cx = targets.reduce((s, n) => s + n.x + n.width / 2, 0) / targets.length;
      const cy = targets.reduce((s, n) => s + n.y + n.height / 2, 0) / targets.length;

      // Determine grid dimensions — aim for ~3 columns
      const cols = Math.min(3, targets.length);
      const rows = Math.ceil(targets.length / cols);
      const gap = 20;

      // Total grid size
      const gridW = targets.reduce((max, n, i) => {
        const col = i % cols;
        return col === 0 ? Math.max(max, n.width) : max + n.width + gap;
      }, 0);

      // We compute per-column max widths and per-row max heights for a tidy grid
      const colWidths: number[] = Array(cols).fill(0);
      const rowHeights: number[] = Array(rows).fill(0);
      targets.forEach((n, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        colWidths[col] = Math.max(colWidths[col], n.width);
        rowHeights[row] = Math.max(rowHeights[row], n.height);
      });

      const totalW = colWidths.reduce((s, w) => s + w, 0) + gap * (cols - 1);
      const totalH = rowHeights.reduce((s, h) => s + h, 0) + gap * (rows - 1);

      // Top-left origin so the grid is centred on the original centroid
      const originX = cx - totalW / 2;
      const originY = cy - totalH / 2;

      // Build cumulative x/y offsets per column/row
      const colX: number[] = [];
      let accX = originX;
      for (let c = 0; c < cols; c++) {
        colX.push(accX);
        accX += colWidths[c] + gap;
      }

      const rowY: number[] = [];
      let accY = originY;
      for (let r = 0; r < rows; r++) {
        rowY.push(accY);
        accY += rowHeights[r] + gap;
      }

      // Apply new positions
      targets.forEach((target, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const node = allNodes.find((n) => n.id === target.id);
        if (node) {
          node.x = Math.round(colX[col]);
          node.y = Math.round(rowY[row]);
        }
      });

      // Suppress unused variable warning
      void gridW;

      return JSON.stringify(canvasData, null, '\t');
    });
  }

  // Enrich selected links in canvas view
  private async enrichSelectedLinks(canvasView: ItemView) {
    const selection = this.getSelectedLinkNodes(canvasView);
    const canvasFile = this.getActiveCanvasFile();

    if (!canvasFile || selection.length === 0) return;

    const enrichedIds: string[] = [];
    for (const node of selection) {
      const result = await this.enrichLinkNode(canvasFile, node);
      if (result.success) {
        enrichedIds.push(node.id);
      }
    }

    // Spread enriched nodes so they don't overlap
    if (enrichedIds.length > 1) {
      await this.spreadNodes(canvasFile, enrichedIds);
    }
  }

  // Enrich all link nodes in canvas
  private async enrichAllLinksInCanvas(canvasFile: TFile) {
    const view = this.getActiveCanvasView();
    if (!view || !('canvas' in view)) {
      new Notice('No active canvas view');
      return;
    }

    type CanvasNodeInternal = {
      getData?: () => { id: string; type: string; url?: string; text?: string; x: number; y: number; width: number; height: number };
    };
    type CanvasInternal = {
      nodes: Map<string, CanvasNodeInternal>;
    };

    const canvas = (view as ItemView & { canvas: CanvasInternal }).canvas;
    if (!canvas?.nodes) {
      new Notice('No canvas nodes found');
      return;
    }

    const validLinks: CanvasLinkData[] = [];
    for (const [, node] of canvas.nodes) {
      const data = node.getData?.();
      if (!data) continue;

      if (data.type === 'link' && typeof data.url === 'string' && isValidUrl(data.url)) {
        validLinks.push(data as unknown as CanvasLinkData);
      } else if (data.type === 'text' && typeof data.text === 'string' && isValidUrl(data.text.trim())) {
        validLinks.push({
          id: data.id, type: 'link', url: data.text.trim(),
          x: data.x, y: data.y, width: data.width, height: data.height,
        } as CanvasLinkData);
      }
    }

    if (validLinks.length === 0) {
      new Notice('No link cards found in canvas');
      return;
    }

    new Notice(`Enriching ${validLinks.length} link cards...`);

    const enrichedIds: string[] = [];
    for (const node of validLinks) {
      const result = await this.enrichLinkNode(canvasFile, node);
      if (result.success) {
        enrichedIds.push(node.id);
      }
    }

    // Spread enriched nodes so they don't overlap
    if (enrichedIds.length > 1) {
      await this.spreadNodes(canvasFile, enrichedIds);
    }

    new Notice('Finished enriching all link cards');
  }

  // Download an image from a URL and save it to the vault
  private async downloadImage(imageUrl: string, nodeId: string): Promise<string | null> {
    try {
      const response = await requestUrl({
        url: imageUrl,
        method: 'GET',
        throw: false,
      });

      if (response.status !== 200) return null;

      // Determine file extension from content-type or URL
      const contentType = response.headers?.['content-type'] ?? '';
      let ext = 'png';
      if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = 'jpg';
      else if (contentType.includes('gif')) ext = 'gif';
      else if (contentType.includes('webp')) ext = 'webp';
      else if (contentType.includes('svg')) ext = 'svg';

      // Save to the notes folder under an images subfolder
      const imagesFolder = `${this.settings.notesFolder}/images`;
      const fileName = `${nodeId}.${ext}`;
      const filePath = `${imagesFolder}/${fileName}`;

      // Ensure images folder exists
      const folder = this.app.vault.getAbstractFileByPath(imagesFolder);
      if (!folder) {
        await this.app.vault.createFolder(imagesFolder);
      }

      // Write the binary data
      const existingFile = this.app.vault.getAbstractFileByPath(filePath);
      if (existingFile) {
        return filePath;  // Already downloaded
      }

      await this.app.vault.createBinary(filePath, response.arrayBuffer);
      return filePath;
    } catch {
      return null;
    }
  }

  // Helper: Get active canvas view
  private getActiveCanvasView(): ItemView | null {
    const view = this.app.workspace.getActiveViewOfType(ItemView);
    if (view?.getViewType() === 'canvas') {
      return view;
    }
    return null;
  }

  // Helper: Get active canvas file
  private getActiveCanvasFile(): TFile | null {
    const view = this.getActiveCanvasView();
    if (!view) return null;
    if ('file' in view && view.file instanceof TFile) {
      return view.file;
    }
    return null;
  }

  // Helper: Get selected link nodes from canvas view
  private getSelectedLinkNodes(canvasView: ItemView): CanvasLinkData[] {
    try {
      if (!('canvas' in canvasView)) return [];

      type CanvasNodeAny = Record<string, unknown> & {
        getData?: () => Record<string, unknown> | undefined;
        url?: string;
        id?: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
      };
      const canvas = (canvasView as ItemView & { canvas: { selection?: Set<CanvasNodeAny> } }).canvas;
      if (!canvas?.selection) return [];

      const selected: CanvasLinkData[] = [];
      for (const node of canvas.selection) {
        // Try getData() first, fall back to reading properties directly from the node instance
        const data = node.getData?.() ?? node;
        if (!data) continue;

        const type = data.type as string | undefined;
        const url = (data.url as string | undefined) ?? (node.url as string | undefined);
        const text = data.text as string | undefined;
        const id = (data.id as string | undefined) ?? (node.id as string | undefined);

        if (type === 'link' && typeof url === 'string' && isValidUrl(url) && id) {
          selected.push({
            id,
            type: 'link',
            url,
            x: (data.x ?? node.x ?? 0) as number,
            y: (data.y ?? node.y ?? 0) as number,
            width: (data.width ?? node.width ?? 400) as number,
            height: (data.height ?? node.height ?? 200) as number,
          } as CanvasLinkData);
        } else if (type === 'text' && typeof text === 'string' && id) {
          // Check if text node contains a URL (either the whole text or first line)
          const firstLine = text.split('\n')[0].trim();
          const urlCandidate = isValidUrl(text.trim()) ? text.trim() : isValidUrl(firstLine) ? firstLine : null;
          if (urlCandidate) {
            selected.push({
              id,
              type: 'link',
              url: urlCandidate,
              x: (data.x ?? node.x ?? 0) as number,
              y: (data.y ?? node.y ?? 0) as number,
              width: (data.width ?? node.width ?? 400) as number,
              height: (data.height ?? node.height ?? 200) as number,
            } as CanvasLinkData);
          }
        }
      }
      return selected;
    } catch (e) {
      console.error('[DetailedCanvas] getSelectedLinkNodes error:', e);
      return [];
    }
  }
}
