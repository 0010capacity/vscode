/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveWindow } from 'vs/base/browser/dom';
import type { IRasterizedGlyph } from 'vs/editor/browser/view/gpu/glyphRasterizer';
import { ensureNonNullable } from 'vs/editor/browser/view/gpu/gpuUtils';
import { TwoKeyMap } from 'vs/editor/browser/view/gpu/multiKeyMap';
import type { ITextureAtlasGlyph } from 'vs/editor/browser/view/gpu/textureAtlas';

export interface ITextureAtlasAllocator {
	readonly glyphMap: TwoKeyMap<string, number, ITextureAtlasGlyph>;
	allocate(chars: string, tokenFg: number, rasterizedGlyph: IRasterizedGlyph): ITextureAtlasGlyph;
	getUsagePreview(): Promise<Blob>;
}

// #region Shelf allocator

export class TextureAtlasShelfAllocator implements ITextureAtlasAllocator {
	private _currentRow: ITextureAtlasShelf = {
		x: 0,
		y: 0,
		h: 0
	};

	// TODO: Allow for multiple active rows
	// public readonly fixedRows: ICharAtlasActiveRow[] = [];

	readonly glyphMap: TwoKeyMap<string, number, ITextureAtlasGlyph> = new TwoKeyMap();

	private _nextIndex = 0;

	constructor(
		private readonly _canvas: OffscreenCanvas,
		private readonly _ctx: OffscreenCanvasRenderingContext2D,
	) {
	}

	public allocate(chars: string, tokenFg: number, rasterizedGlyph: IRasterizedGlyph): ITextureAtlasGlyph {
		// Finalize row if it doesn't fix
		if (rasterizedGlyph.boundingBox.right - rasterizedGlyph.boundingBox.left > this._canvas.width - this._currentRow.x) {
			this._currentRow.x = 0;
			this._currentRow.y += this._currentRow.h;
			this._currentRow.h = 1;
		}

		// TODO: Handle end of atlas page

		// Draw glyph
		const glyphWidth = rasterizedGlyph.boundingBox.right - rasterizedGlyph.boundingBox.left + 1;
		const glyphHeight = rasterizedGlyph.boundingBox.bottom - rasterizedGlyph.boundingBox.top + 1;
		// TODO: Prefer putImageData as it doesn't do blending or scaling
		this._ctx.drawImage(
			rasterizedGlyph.source,
			// source
			rasterizedGlyph.boundingBox.left,
			rasterizedGlyph.boundingBox.top,
			glyphWidth,
			glyphHeight,
			// destination
			this._currentRow.x,
			this._currentRow.y,
			glyphWidth,
			glyphHeight
		);

		// Create glyph object
		const glyph: ITextureAtlasGlyph = {
			index: this._nextIndex++,
			x: this._currentRow.x,
			y: this._currentRow.y,
			w: glyphWidth,
			h: glyphHeight,
			originOffsetX: rasterizedGlyph.originOffset.x,
			originOffsetY: rasterizedGlyph.originOffset.y
		};

		// Shift current row
		this._currentRow.x += glyphWidth;
		this._currentRow.h = Math.max(this._currentRow.h, glyphHeight);

		// Set the glyph
		this.glyphMap.set(chars, tokenFg, glyph);

		return glyph;
	}

	public getUsagePreview(): Promise<Blob> {
		// TODO: This is specific to the simple shelf allocator
		const w = this._canvas.width;
		const h = this._canvas.height;
		const canvas = new OffscreenCanvas(w, h);
		const ctx = ensureNonNullable(canvas.getContext('2d'));
		ctx.fillStyle = '#808080';
		ctx.fillRect(0, 0, w, h);

		let usedPixels = 0;
		let wastedPixels = 0;
		const totalPixels = w * h;

		const rowHeight: Map<number, number> = new Map(); // y -> h
		const rowWidth: Map<number, number> = new Map(); // y -> w
		for (const g of this.glyphMap.values()) {
			rowHeight.set(g.y, Math.max(rowHeight.get(g.y) ?? 0, g.h));
			rowWidth.set(g.y, Math.max(rowWidth.get(g.y) ?? 0, g.x + g.w));
		}
		for (const g of this.glyphMap.values()) {
			usedPixels += g.w * g.h;
			wastedPixels += g.w * (rowHeight.get(g.y)! - g.h);
			ctx.fillStyle = '#4040FF';
			ctx.fillRect(g.x, g.y, g.w, g.h);
			ctx.fillStyle = '#FF0000';
			ctx.fillRect(g.x, g.y + g.h, g.w, rowHeight.get(g.y)! - g.h);
		}
		for (const [rowY, rowW] of rowWidth.entries()) {
			if (rowY !== this._currentRow.y) {
				ctx.fillStyle = '#FF0000';
				ctx.fillRect(rowW, rowY, w - rowW, rowHeight.get(rowY)!);
				wastedPixels += (w - rowW) * rowHeight.get(rowY)!;
			}
		}
		console.log([
			`Texture atlas stats:`,
			`     Total: ${totalPixels}`,
			`      Used: ${usedPixels} (${((usedPixels / totalPixels) * 100).toPrecision(2)}%)`,
			`    Wasted: ${wastedPixels} (${((wastedPixels / totalPixels) * 100).toPrecision(2)}%)`,
			`Efficiency: ${((usedPixels / (usedPixels + wastedPixels)) * 100).toPrecision(2)}%`,
		].join('\n'));
		return canvas.convertToBlob();
	}
}

interface ITextureAtlasShelf {
	x: number;
	y: number;
	h: number;
}

// #endregion

// #region Slab allocator

export class TextureAtlasSlabAllocator implements ITextureAtlasAllocator {
	// TODO: Is there a better way to index slabs other than an unsorted list?
	private _slabs: ITextureAtlasSlab[] = [];
	private _activeSlabsByDims: TwoKeyMap<number, number, ITextureAtlasSlab> = new TwoKeyMap();

	private _unusedRects: ITextureAtlasSlabUnusedRect[] = [];

	readonly glyphMap: TwoKeyMap<string, number, ITextureAtlasGlyph> = new TwoKeyMap();

	private _nextIndex = 0;

	constructor(
		private readonly _canvas: OffscreenCanvas,
		private readonly _ctx: OffscreenCanvasRenderingContext2D,
	) {
	}

	public allocate(chars: string, tokenFg: number, rasterizedGlyph: IRasterizedGlyph): ITextureAtlasGlyph {
		// Find ideal slab, creating it if there is none suitable
		const glyphWidth = rasterizedGlyph.boundingBox.right - rasterizedGlyph.boundingBox.left + 1;
		const glyphHeight = rasterizedGlyph.boundingBox.bottom - rasterizedGlyph.boundingBox.top + 1;
		const dpr = getActiveWindow().devicePixelRatio;

		// Round slab glyph dimensions to the nearest x pixels, where x scaled with device pixel ratio
		const nearestXPixels = Math.max(1, Math.floor(dpr / 0.5));
		const desiredSlabSize = {
			// Nearest square number
			// TODO: This can probably be optimized
			// w: 1 << Math.ceil(Math.sqrt(glyphWidth)),
			// h: 1 << Math.ceil(Math.sqrt(glyphHeight)),

			// Nearest x px
			w: Math.ceil(glyphWidth / nearestXPixels) * nearestXPixels,
			h: Math.ceil(glyphHeight / nearestXPixels) * nearestXPixels,

			// Round odd numbers up
			// w: glyphWidth % 0 === 1 ? glyphWidth + 1 : glyphWidth,
			// h: glyphHeight % 0 === 1 ? glyphHeight + 1 : glyphHeight,

			// Exact number only
			// w: glyphWidth,
			// h: glyphHeight,
		};

		const slabW = 64 << (Math.floor(getActiveWindow().devicePixelRatio) - 1); // this._canvas.width / 8;
		const slabH = slabW; // this._canvas.height / 8;
		const slabsPerRow = Math.floor(this._canvas.width / slabW);

		// Get any existing slab
		let slab = this._activeSlabsByDims.get(desiredSlabSize.w, desiredSlabSize.h);

		// Check if the slab is full
		if (slab) {
			const glyphsPerSlab = Math.floor(slabW / slab.entryW) * Math.floor(slabH / slab.entryH);
			if (slab.count >= glyphsPerSlab) {
				slab = undefined;
			}
		}

		let dx: number | undefined;
		let dy: number | undefined;

		// Search for suitable space in unused rectangles
		if (!slab) {
			for (const [i, r] of this._unusedRects.entries()) {
				if (r.w < r.h) {
					if (r.w >= glyphWidth && r.h >= glyphHeight) {
						dx = r.x;
						dy = r.y;
						if (glyphWidth < r.w) {
							this._unusedRects.push({
								x: r.x + glyphWidth,
								y: r.y,
								w: r.w - glyphWidth,
								h: glyphHeight
							});
						}
						r.y += glyphHeight;
						r.h -= glyphHeight;
						if (r.h === 0) {
							// TODO: This is slow
							this._unusedRects.splice(i, 1);
						}
						break;
					}
				} else {
					if (r.w >= glyphWidth && r.h >= glyphHeight) {
						dx = r.x;
						dy = r.y;
						if (glyphHeight < r.h) {
							this._unusedRects.push({
								x: r.x,
								y: r.y + glyphHeight,
								w: glyphWidth,
								h: r.h - glyphHeight
							});
						}
						r.x += glyphWidth;
						r.w -= glyphWidth;
						if (r.w === 0) {
							// TODO: This is slow
							this._unusedRects.splice(i, 1);
						}
					}
				}
			}
		}

		// Create a new slab
		if (dx === undefined || dy === undefined) {
			if (!slab) {
				slab = {
					x: Math.floor(this._slabs.length % slabsPerRow) * slabW,
					y: Math.floor(this._slabs.length / slabsPerRow) * slabH,
					entryW: desiredSlabSize.w,
					entryH: desiredSlabSize.h,
					count: 0
				};
				// Track unused regions to use for small glyphs
				// +-------------+----+
				// |             |    |
				// |             |    | <- Unused W region
				// |             |    |
				// |-------------+----+
				// |                  | <- Unused H region
				// +------------------+
				const unusedW = slabW % slab.entryW;
				const unusedH = slabH % slab.entryH;
				if (unusedW) {
					this._unusedRects.push({
						x: slab.x + slabW - unusedW,
						w: unusedW,
						y: slab.y,
						h: slabH - (unusedH ?? 0)
					});
				}
				if (unusedH) {
					this._unusedRects.push({
						x: slab.x,
						w: slabW,
						y: slab.y + slabH - unusedH,
						h: unusedH
					});
				}
				this._slabs.push(slab);
				this._activeSlabsByDims.set(desiredSlabSize.w, desiredSlabSize.h, slab);
			}

			const glyphsPerRow = Math.floor(slabW / slab.entryW);
			dx = slab.x + Math.floor(slab.count % glyphsPerRow) * slab.entryW;
			dy = slab.y + Math.floor(slab.count / glyphsPerRow) * slab.entryH;

			// Shift current row
			slab.count++;
		}

		// Draw glyph
		// TODO: Prefer putImageData as it doesn't do blending or scaling
		this._ctx.drawImage(
			rasterizedGlyph.source,
			// source
			rasterizedGlyph.boundingBox.left,
			rasterizedGlyph.boundingBox.top,
			glyphWidth,
			glyphHeight,
			// destination
			dx,
			dy,
			glyphWidth,
			glyphHeight
		);

		// Create glyph object
		const glyph: ITextureAtlasGlyph = {
			index: this._nextIndex++,
			x: dx,
			y: dy,
			w: glyphWidth,
			h: glyphHeight,
			originOffsetX: rasterizedGlyph.originOffset.x,
			originOffsetY: rasterizedGlyph.originOffset.y
		};

		// Set the glyph
		this.glyphMap.set(chars, tokenFg, glyph);

		return glyph;
	}

	public getUsagePreview(): Promise<Blob> {
		// TODO: This is specific to the simple shelf allocator
		const w = this._canvas.width;
		const h = this._canvas.height;
		const canvas = new OffscreenCanvas(w, h);
		const ctx = ensureNonNullable(canvas.getContext('2d'));

		ctx.fillStyle = '#808080';
		ctx.fillRect(0, 0, w, h);

		let slabEntryPixels = 0;
		let usedPixels = 0;
		let slabEdgePixels = 0;
		let wastedPixels = 0;
		let restrictedPixels = 0;
		const totalPixels = w * h;
		const slabW = 64 << (Math.floor(getActiveWindow().devicePixelRatio) - 1);
		const slabH = slabW;

		// Draw wasted underneath glyphs first
		for (const slab of this._slabs) {
			let x = 0;
			let y = 0;
			for (let i = 0; i < slab.count; i++) {
				if (x + slab.entryW > slabW) {
					x = 0;
					y += slab.entryH;
				}
				// TODO: This doesn't visualize wasted space between entries - draw glyphs on top?
				ctx.fillStyle = '#FF0000';
				ctx.fillRect(slab.x + x, slab.y + y, slab.entryW, slab.entryH);

				slabEntryPixels += slab.entryW * slab.entryH;
				x += slab.entryW;
			}
			const entriesPerRow = Math.floor(slabW / slab.entryW);
			const entriesPerCol = Math.floor(slabH / slab.entryH);
			const thisSlabPixels = slab.entryW * entriesPerRow * slab.entryH * entriesPerCol;
			slabEdgePixels += (slabW * slabH) - thisSlabPixels;
		}

		// Draw glyphs
		for (const g of this.glyphMap.values()) {
			usedPixels += g.w * g.h;
			ctx.fillStyle = '#4040FF';
			ctx.fillRect(g.x, g.y, g.w, g.h);
		}

		// Draw unused space on side
		for (const r of this._unusedRects) {
			ctx.fillStyle = '#FF000080';
			ctx.fillRect(r.x, r.y, r.w, r.h);
			restrictedPixels += r.w * r.h;
		}

		const edgeUsedPixels = slabEdgePixels - restrictedPixels;
		console.log({ edgeUsedPixels, slabEdgePixels, restrictedPixels });
		wastedPixels = slabEntryPixels - (usedPixels - edgeUsedPixels);


		// Overlay actual glyphs on top
		ctx.globalAlpha = 0.5;
		ctx.drawImage(this._canvas, 0, 0);
		ctx.globalAlpha = 1;

		// usedPixels += slabEdgePixels - restrictedPixels;
		const efficiency = usedPixels / (usedPixels + wastedPixels + restrictedPixels);

		// Report stats
		console.log([
			`Texture atlas stats:`,
			`     Total: ${totalPixels}px`,
			`      Used: ${usedPixels}px (${((usedPixels / totalPixels) * 100).toFixed(2)}%)`,
			`    Wasted: ${wastedPixels}px (${((wastedPixels / totalPixels) * 100).toFixed(2)}%)`,
			`Restricted: ${restrictedPixels}px (${((restrictedPixels / totalPixels) * 100).toFixed(2)}%) (hard to allocate)`,
			`Efficiency: ${efficiency === 1 ? '100' : (efficiency * 100).toFixed(2)}%`,
			`     Slabs: ${this._slabs.length} of ${Math.floor(this._canvas.width / slabW) * Math.floor(this._canvas.height / slabH)}`
		].join('\n'));

		return canvas.convertToBlob();
	}
}

interface ITextureAtlasSlab {
	x: number;
	y: number;
	entryH: number;
	entryW: number;
	count: number;
}

export interface ITextureAtlasSlabUnusedRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

// #endregion
