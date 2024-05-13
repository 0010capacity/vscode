/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { ensureNonNullable } from 'vs/editor/browser/view/gpu/gpuUtils';

export class GlyphRasterizer extends Disposable {
	private _canvas: OffscreenCanvas;
	// A temporary context that glyphs are drawn to before being transfered to the atlas.
	private _ctx: OffscreenCanvasRenderingContext2D;

	constructor(
		private readonly _fontSize: number,
		fontFamily: string,
	) {
		super();

		this._canvas = new OffscreenCanvas(this._fontSize * 3, this._fontSize * 3);
		this._ctx = ensureNonNullable(this._canvas.getContext('2d', {
			willReadFrequently: true
		}));
		this._ctx.font = `${this._fontSize}px ${fontFamily}`;
		this._ctx.textBaseline = 'top';
		this._ctx.fillStyle = '#FFFFFF';
	}

	// TODO: Support drawing multiple fonts and sizes
	// TODO: Should pull in the font size from config instead of random dom node
	public rasterizeGlyph(chars: string, fg: string): IRasterizedGlyph {
		this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);

		// TODO: Draw in middle using alphabetical baseline
		const originX = this._fontSize;
		const originY = this._fontSize;
		this._ctx.fillStyle = fg;
		const textMetrics = this._ctx.measureText(chars);
		this._ctx.fillText(chars, originX, originY);

		const imageData = this._ctx.getImageData(0, 0, this._canvas.width, this._canvas.height);
		// TODO: Hot path: Reuse object
		const boundingBox = this._findGlyphBoundingBox(imageData);
		// const offset = {
		// 	x: textMetrics.actualBoundingBoxLeft,
		// 	y: textMetrics.actualBoundingBoxAscent
		// };
		// const size = {
		// 	w: textMetrics.actualBoundingBoxRight + textMetrics.actualBoundingBoxLeft,
		// 	y: textMetrics.actualBoundingBoxDescent + textMetrics.actualBoundingBoxAscent,
		// 	wInt: Math.ceil(textMetrics.actualBoundingBoxRight + textMetrics.actualBoundingBoxLeft),
		// 	yInt: Math.ceil(textMetrics.actualBoundingBoxDescent + textMetrics.actualBoundingBoxAscent),
		// };
		// console.log(`${chars}_${fg}`, textMetrics, boundingBox, originX, originY, { width: boundingBox.right - boundingBox.left, height: boundingBox.bottom - boundingBox.top });
		const result: IRasterizedGlyph = {
			source: this._canvas,
			boundingBox,
			originOffset: {
				x: boundingBox.left - originX,
				y: boundingBox.top - originY
			}
		};
		const result2: IRasterizedGlyph = {
			source: this._canvas,
			boundingBox: {
				left: Math.floor(originX - textMetrics.actualBoundingBoxLeft),
				right: Math.ceil(originX + textMetrics.actualBoundingBoxRight),
				top: Math.floor(originY - textMetrics.actualBoundingBoxAscent),
				bottom: Math.ceil(originY + textMetrics.actualBoundingBoxDescent),
			},
			originOffset: {
				x: Math.floor(boundingBox.left - originX),
				y: Math.floor(boundingBox.top - originY)
			}
		};

		// DEBUG: Show image data in console
		// (console as any).image(imageData);

		// TODO: Verify result 1 and 2 are the same

		// if (result2.boundingBox.left > result.boundingBox.left) {
		// 	debugger;
		// }
		// if (result2.boundingBox.top > result.boundingBox.top) {
		// 	debugger;
		// }
		// if (result2.boundingBox.right < result.boundingBox.right) {
		// 	debugger;
		// }
		// if (result2.boundingBox.bottom < result.boundingBox.bottom) {
		// 	debugger;
		// }
		if (JSON.stringify(result2.originOffset) !== JSON.stringify(result.originOffset)) {
			debugger;
		}

		return result;
	}

	// TODO: Does this even need to happen when measure text is used?
	// TODO: Pass back origin offset
	private _findGlyphBoundingBox(imageData: ImageData): IBoundingBox {

		// TODO: Hot path: Reuse object
		const boundingBox = {
			left: 0,
			top: 0,
			right: 0,
			bottom: 0
		};
		// TODO: This could be optimized to be aware of the font size padding on all sides
		const height = this._canvas.height;
		const width = this._canvas.width;
		let found = false;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const alphaOffset = y * width * 4 + x * 4 + 3;
				if (imageData.data[alphaOffset] !== 0) {
					boundingBox.top = y;
					found = true;
					break;
				}
			}
			if (found) {
				break;
			}
		}
		boundingBox.left = 0;
		found = false;
		for (let x = 0; x < width; x++) {
			for (let y = 0; y < height; y++) {
				const alphaOffset = y * width * 4 + x * 4 + 3;
				if (imageData.data[alphaOffset] !== 0) {
					boundingBox.left = x;
					found = true;
					break;
				}
			}
			if (found) {
				break;
			}
		}
		boundingBox.right = width;
		found = false;
		for (let x = width - 1; x >= boundingBox.left; x--) {
			for (let y = 0; y < height; y++) {
				const alphaOffset = y * width * 4 + x * 4 + 3;
				if (imageData.data[alphaOffset] !== 0) {
					boundingBox.right = x;
					found = true;
					break;
				}
			}
			if (found) {
				break;
			}
		}
		boundingBox.bottom = boundingBox.top;
		found = false;
		for (let y = height - 1; y >= 0; y--) {
			for (let x = 0; x < width; x++) {
				const alphaOffset = y * width * 4 + x * 4 + 3;
				if (imageData.data[alphaOffset] !== 0) {
					boundingBox.bottom = y;
					found = true;
					break;
				}
			}
			if (found) {
				break;
			}
		}
		return boundingBox;
	}
}

export interface IBoundingBox {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface IRasterizedGlyph {
	source: CanvasImageSource;
	boundingBox: IBoundingBox;
	originOffset: { x: number; y: number };
}
