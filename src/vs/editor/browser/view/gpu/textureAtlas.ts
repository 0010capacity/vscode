/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveWindow } from 'vs/base/browser/dom';
import { Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { GlyphRasterizer } from 'vs/editor/browser/view/gpu/glyphRasterizer';
import { ensureNonNullable } from 'vs/editor/browser/view/gpu/gpuUtils';
import { IdleTaskQueue } from 'vs/editor/browser/view/gpu/taskQueue';
import { TextureAtlasPage } from 'vs/editor/browser/view/gpu/textureAtlasPage';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IThemeService } from 'vs/platform/theme/common/themeService';

// DEBUG: This helper can be used to draw image data to the console, it's commented out as we don't
//        want to ship it, but this is very useful for investigating texture atlas issues.
// (console as any).image = (source: ImageData | HTMLCanvasElement, scale: number = 1) => {
// 	function getBox(width: number, height: number) {
// 		return {
// 			string: '+',
// 			style: 'font-size: 1px; padding: ' + Math.floor(height / 2) + 'px ' + Math.floor(width / 2) + 'px; line-height: ' + height + 'px;'
// 		};
// 	}
// 	if (source instanceof HTMLCanvasElement) {
// 		source = source.getContext('2d')?.getImageData(0, 0, source.width, source.height)!;
// 	}
// 	const canvas = document.createElement('canvas');
// 	canvas.width = source.width;
// 	canvas.height = source.height;
// 	const ctx = canvas.getContext('2d')!;
// 	ctx.putImageData(source, 0, 0);

// 	const sw = source.width * scale;
// 	const sh = source.height * scale;
// 	const dim = getBox(sw, sh);
// 	console.log(
// 		`Image: ${source.width} x ${source.height}\n%c${dim.string}`,
// 		`${dim.style}background: url(${canvas.toDataURL()}); background-size: ${sw}px ${sh}px; background-repeat: no-repeat; color: transparent;`
// 	);
// 	console.groupCollapsed('Zoomed');
// 	console.log(
// 		`%c${dim.string}`,
// 		`${getBox(sw * 10, sh * 10).style}background: url(${canvas.toDataURL()}); background-size: ${sw * 10}px ${sh * 10}px; background-repeat: no-repeat; color: transparent; image-rendering: pixelated;-ms-interpolation-mode: nearest-neighbor;`
// 	);
// 	console.groupEnd();
// };

export class TextureAtlas extends Disposable {
	public get glyphs(): IterableIterator<ITextureAtlasGlyph> {
		return this._page.glyphs;
	}

	private readonly _glyphRasterizer: GlyphRasterizer;

	private _colorMap!: string[];
	private _warmUpTask?: IdleTaskQueue;

	public get source(): OffscreenCanvas {
		return this._page.source;
	}

	public get hasChanges(): boolean {
		return this._page.hasChanges;
	}
	public set hasChanges(value: boolean) {
		this._page.hasChanges = value;
	}

	private readonly _page: TextureAtlasPage;

	// TODO: Should pull in the font size from config instead of random dom node
	constructor(
		parentDomNode: HTMLElement,
		pageSize: number,
		maxTextureSize: number,
		@IThemeService private readonly _themeService: IThemeService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService
	) {
		super();

		const activeWindow = getActiveWindow();
		const style = activeWindow.getComputedStyle(parentDomNode);
		const fontSize = Math.ceil(parseInt(style.fontSize) * activeWindow.devicePixelRatio);
		// this._ctx.font = `${fontSize}px ${style.fontFamily}`;

		this._register(Event.runAndSubscribe(this._themeService.onDidColorThemeChange, () => {
			// TODO: Clear entire atlas on theme change
			this._colorMap = this._themeService.getColorTheme().tokenColorMap;
			this._warmUpAtlas();
		}));

		this._glyphRasterizer = new GlyphRasterizer(fontSize, style.fontFamily);
		// this._allocator = new TextureAtlasShelfAllocator(this._canvas, this._ctx);

		this._page = this._register(this._instantiationService.createInstance(TextureAtlasPage, parentDomNode, pageSize, maxTextureSize, this._glyphRasterizer));
	}

	// TODO: Color, style etc.
	public getGlyph(chars: string, tokenFg: number): ITextureAtlasGlyph {
		return this._page.getGlyph(chars, tokenFg);
	}

	public getUsagePreview(): Promise<Blob> {
		const w = this._page.source.width;
		const h = this._page.source.height;
		const canvas = new OffscreenCanvas(w, h);
		const ctx = ensureNonNullable(canvas.getContext('2d'));
		ctx.fillStyle = '#808080';
		ctx.fillRect(0, 0, w, h);
		ctx.fillStyle = '#4040FF';
		for (const g of this.glyphs) {
			ctx.fillRect(g.x, g.y, g.w, g.h);
		}
		return canvas.convertToBlob();
	}

	/**
	 * Warms up the atlas by rasterizing all printable ASCII characters for each token color. This
	 * is distrubuted over multiple idle callbacks to avoid blocking the main thread.
	 */
	private _warmUpAtlas(): void {
		// TODO: Clean up on dispose
		this._warmUpTask?.clear();
		this._warmUpTask = new IdleTaskQueue();
		for (const tokenFg of this._colorMap.keys()) {
			this._warmUpTask.enqueue(() => {
				for (let code = 33; code <= 126; code++) {
					this.getGlyph(String.fromCharCode(code), tokenFg);
				}
			});
		}
	}
}

export interface ITextureAtlasGlyph {
	index: number;
	x: number;
	y: number;
	w: number;
	h: number;
	originOffsetX: number;
	originOffsetY: number;
}

export interface IBoundingBox {
	left: number;
	top: number;
	right: number;
	bottom: number;
}
