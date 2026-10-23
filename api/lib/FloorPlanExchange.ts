// Floorplan export/import.
//
// An export file holds one or more maps with their background pictures
// (base64) and a manifest describing each node they mention. Positions refer
// to the manifest by `ref`, never by node ID, so an import can remap them onto
// a different network. The browser proposes the matches and the user reviews
// them: this module only builds and parses files, `FloorPlans.importMaps`
// writes.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { FloorPlansData, MapView, NodeFilter, Rect } from './FloorPlans.ts'
import {
	MAX_IMAGE_BYTES,
	MAX_IMAGE_MB,
	MAX_NODE_LIST,
	checkView,
	cleanName,
	isCoord,
	isDim,
	sniffImage,
} from './FloorPlans.ts'
import { module } from './logger.ts'

const logger = module('FloorPlanExchange')

export const FORMAT = 'zwjsui-floorplan'
export const FORMAT_VERSION = 2
/**
 * Largest export or import file. An import is parsed in one go, which blocks
 * the server for a moment, so this stays well below what JSON could hold.
 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024
export const MAX_FILE_MB = MAX_FILE_BYTES / 1024 / 1024
const MAX_MAPS = 50

/** This network's nodes, in the shape export needs */
export interface LocalNode {
	key: string
	id: number
	name?: string
	loc?: string
	deviceId?: string
	productLabel?: string
	manufacturer?: string
	firmwareVersion?: string
	controller: boolean
}

/** A node described in an export file */
export interface FileNode {
	ref: string
	homeId: string | null
	nodeId: number | null
	name: string | null
	loc: string | null
	deviceId: string | null
	productLabel: string | null
	manufacturer: string | null
	firmwareVersion: string | null
	controller: boolean
}

interface FileImage {
	type: string
	data: string
}

export interface ExportFile {
	format: typeof FORMAT
	version: typeof FORMAT_VERSION
	exportedAt: string
	source: { homeId: string | null; appVersion: string | null }
	maps: {
		name: string
		widthPx: number
		heightPx: number
		background: {
			imageRect: Rect
			image: FileImage | null
			darkImage: FileImage | null
		} | null
		nodes: { start: NodeFilter['start']; exceptions: string[] }
		view: MapView
		placements: { ref: string; x: number; y: number }[]
	}[]
	nodes: FileNode[]
}

/** A map of a validated import file, pictures decoded */
export interface ImportedMap {
	name: string
	widthPx: number
	heightPx: number
	background: {
		imageRect: Rect
		image: Buffer | null
		darkImage: Buffer | null
	} | null
	nodes: { start: NodeFilter['start']; exceptionRefs: string[] }
	view: MapView
	placements: { ref: string; x: number; y: number }[]
}

/** A validated import file */
export interface ParsedImport {
	source: { homeId: string | null; appVersion: string | null }
	exportedAt: string | null
	maps: ImportedMap[]
	nodes: FileNode[]
}

const TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	webp: 'image/webp',
}

/**
 * A device model ID as Z-Wave JS UI builds it (manufacturerId-productId-
 * productType), or null. A node interviewed without those IDs has
 * "undefined-undefined-undefined", which must not count as a model.
 */
export function cleanDeviceId(id: unknown): string | null {
	return typeof id === 'string' && /^\d+-\d+-\d+$/.test(id) ? id : null
}

/** Device key of a node: `zwave:<home ID in hex, no 0x>:<node ID>` */
export function deviceKey(homeHex: string, nodeId: number) {
	return `zwave:${homeHex.replace(/^0x/, '')}:${nodeId}`
}

/** This network's nodes, or [] while the driver isn't ready */
export function localNodes(
	zwave:
		| {
				homeHex?: string
				nodes: Map<
					number,
					{
						id: number
						name?: string
						loc?: string
						deviceId?: string
						productLabel?: string
						manufacturer?: string
						firmwareVersion?: string
						isControllerNode?: boolean
					}
				>
		  }
		| undefined,
): LocalNode[] {
	if (!zwave?.homeHex) return []
	return [...zwave.nodes.values()].map((n) => ({
		key: deviceKey(zwave.homeHex, n.id),
		id: n.id,
		name: n.name,
		loc: n.loc,
		deviceId: cleanDeviceId(n.deviceId) ?? undefined,
		productLabel: n.productLabel,
		manufacturer: n.manufacturer,
		firmwareVersion: n.firmwareVersion,
		controller: !!n.isControllerNode,
	}))
}

const tooLarge = () =>
	Error(
		`The export would be larger than ${MAX_FILE_MB} MB. Export fewer maps at a time, or use smaller pictures.`,
	)

/**
 * Build the export file for the given maps (all maps when `mapIds` is null).
 * A node that's gone from the network is described by its home and node ID
 * only. A picture missing on disk is logged and exported as null. Refuses a
 * file larger than MAX_FILE_BYTES, so every export can be imported again.
 */
export async function buildExport({
	data,
	mapIds = null,
	nodes,
	imagesDir,
	homeId = null,
	appVersion = null,
}: {
	data: FloorPlansData
	mapIds?: string[] | null
	nodes: LocalNode[]
	imagesDir: string
	homeId?: string | null
	appVersion?: string | null
}): Promise<ExportFile> {
	const maps = mapIds
		? mapIds.map((id) => {
				const m = data.maps.find((x) => x.id === id)
				if (!m) throw Error('No such map')
				return m
			})
		: data.maps
	if (!maps.length) throw Error('There are no maps to export')

	const byKey = new Map(nodes.map((n) => [n.key, n]))
	const entries: FileNode[] = []
	const refOf = new Map<string, string>()
	const describe = (key: string) => {
		if (refOf.has(key)) return refOf.get(key)
		const ref = `n${entries.length + 1}`
		const [, home, id] = key.split(':')
		const n = byKey.get(key)
		entries.push({
			ref,
			homeId: home,
			nodeId: Number(id),
			name: n?.name || null,
			loc: n?.loc || null,
			deviceId: cleanDeviceId(n?.deviceId),
			productLabel: n?.productLabel || null,
			manufacturer: n?.manufacturer || null,
			firmwareVersion: n?.firmwareVersion || null,
			controller: !!n?.controller,
		})
		refOf.set(key, ref)
		return ref
	}

	// stop reading pictures as soon as they alone are too large
	let imageBytes = 0
	const read = async (file: string | null): Promise<FileImage | null> => {
		if (!file) return null
		let bytes: Buffer
		try {
			bytes = await readFile(path.join(imagesDir, file))
		} catch (error) {
			logger.warn(
				`Floorplan image ${file} left out of the export: ${error.message}`,
			)
			return null
		}
		const ext = path.extname(file).slice(1).toLowerCase()
		const out = {
			type: TYPES[ext] ?? 'application/octet-stream',
			data: bytes.toString('base64'),
		}
		imageBytes += out.data.length
		if (imageBytes > MAX_FILE_BYTES) throw tooLarge()
		return out
	}

	const outMaps: ExportFile['maps'] = []
	for (const m of maps) {
		const bg = m.background
		outMaps.push({
			name: m.name,
			widthPx: m.widthPx,
			heightPx: m.heightPx,
			background: bg
				? {
						imageRect: { ...bg.imageRect },
						image: await read(bg.image),
						darkImage: await read(bg.darkImage),
					}
				: null,
			nodes: {
				start: m.nodes.start,
				exceptions: m.nodes.exceptions.map(describe),
			},
			view: m.view,
			placements: m.placements.map((p) => ({
				ref: describe(p.deviceKey),
				x: p.x,
				y: p.y,
			})),
		})
	}

	const out: ExportFile = {
		format: FORMAT,
		version: FORMAT_VERSION,
		exportedAt: new Date().toISOString(),
		source: { homeId, appVersion },
		maps: outMaps,
		nodes: entries,
	}
	if (Buffer.byteLength(JSON.stringify(out)) > MAX_FILE_BYTES) {
		throw tooLarge()
	}
	return out
}

const str = (v: unknown, max = 200) =>
	typeof v === 'string' && v ? v.slice(0, max) : null

/**
 * Bring a file written by an older version up to the current format.
 * Version 1 kept the pictures in a shared `backgrounds` list that maps
 * referred to; now each map carries its own.
 */
function migrateFile(file: any) {
	if (file.version === 1) {
		const bgs = new Map<unknown, any>(
			(Array.isArray(file.backgrounds) ? file.backgrounds : []).map(
				(b: any) => [b?.ref, b],
			),
		)
		const maps = Array.isArray(file.maps)
			? file.maps.map((m: any) => {
					if (m?.background == null) return m
					const bg = bgs.get(m.background.ref)
					if (!bg) {
						throw Error(
							'Not a usable floorplan file: a map refers to an unknown background',
						)
					}
					return {
						...m,
						background: {
							imageRect: m.background.imageRect,
							image: bg.image ?? null,
							darkImage: bg.imageDark ?? null,
						},
					}
				})
			: file.maps
		file = { ...file, version: 2, maps }
		delete file.backgrounds
	}
	return file
}

/** Parse and validate an uploaded export file. Throws with a plain reason. */
export function parseImport(bytes: Buffer): ParsedImport {
	if (bytes.length > MAX_FILE_BYTES) {
		throw Error(`File is larger than ${MAX_FILE_MB} MB`)
	}
	let file: any
	try {
		file = JSON.parse(bytes.toString('utf8'))
	} catch {
		throw Error("That isn't a floorplan file (not JSON)")
	}
	const bad = (why: string) => Error(`Not a usable floorplan file: ${why}`)
	if (file?.format !== FORMAT) throw bad('wrong format')
	if (
		!Number.isInteger(file.version) ||
		file.version < 1 ||
		file.version > FORMAT_VERSION
	) {
		throw bad(
			`version ${file.version} isn't supported (this release reads up to ${FORMAT_VERSION})`,
		)
	}
	file = migrateFile(file)

	if (!Array.isArray(file.nodes) || file.nodes.length > MAX_NODE_LIST) {
		throw bad('node list is invalid')
	}
	const refs = new Set<string>()
	const nodes: FileNode[] = file.nodes.map((n: any) => {
		if (typeof n?.ref !== 'string' || !n.ref || refs.has(n.ref)) {
			throw bad('node refs must be unique strings')
		}
		refs.add(n.ref)
		return {
			ref: n.ref,
			homeId: str(n.homeId),
			nodeId: Number.isInteger(n.nodeId) ? n.nodeId : null,
			name: str(n.name),
			loc: str(n.loc),
			deviceId: cleanDeviceId(n.deviceId),
			productLabel: str(n.productLabel),
			manufacturer: str(n.manufacturer),
			firmwareVersion: str(n.firmwareVersion),
			controller: n.controller === true,
		}
	})

	const decode = (img: any, what: string) => {
		if (img == null) return null
		if (typeof img.data !== 'string') throw bad(`${what} has no data`)
		const buf = Buffer.from(img.data, 'base64')
		if (buf.length > MAX_IMAGE_BYTES) {
			throw Error(`${what} is larger than ${MAX_IMAGE_MB} MB`)
		}
		if (!sniffImage(buf)) {
			throw Error(`${what} isn't a PNG, JPEG or WebP image`)
		}
		return buf
	}

	if (
		!Array.isArray(file.maps) ||
		!file.maps.length ||
		file.maps.length > MAX_MAPS
	) {
		throw bad('map list is invalid')
	}
	const maps: ImportedMap[] = file.maps.map((m: any) => {
		if (typeof m?.name !== 'string') throw bad('a map has no name')
		if (!isDim(m.widthPx) || !isDim(m.heightPx)) {
			throw bad('map size is invalid')
		}
		let background: ImportedMap['background'] = null
		if (m.background != null) {
			const r = m.background.imageRect
			if (
				![r?.x, r?.y, r?.w, r?.h].every(isCoord) ||
				!(r.w > 0 && r.h > 0)
			) {
				throw bad('imageRect is invalid')
			}
			const image = decode(m.background.image, 'background picture')
			const darkImage = decode(
				m.background.darkImage,
				'dark background picture',
			)
			// a background without pictures is no background
			if (image || darkImage) {
				background = {
					imageRect: { x: r.x, y: r.y, w: r.w, h: r.h },
					image,
					darkImage,
				}
			}
		}
		if (!Array.isArray(m.placements)) throw bad('placements are invalid')
		const placed = new Set<string>()
		const placements = m.placements.map((p: any) => {
			if (!refs.has(p?.ref)) {
				throw bad('a placement refers to an unknown node')
			}
			if (placed.has(p.ref)) {
				throw bad('a map places the same node twice')
			}
			placed.add(p.ref)
			if (!isCoord(p.x) || !isCoord(p.y)) {
				throw bad('a placement has invalid coordinates')
			}
			return { ref: p.ref, x: p.x, y: p.y }
		})
		const exceptions = m.nodes?.exceptions
		return {
			name: cleanName(m.name, 'Imported map'),
			widthPx: m.widthPx,
			heightPx: m.heightPx,
			background,
			nodes: {
				start: m.nodes?.start === 'exclude' ? 'exclude' : 'include',
				exceptionRefs: Array.isArray(exceptions)
					? [
							...new Set<string>(
								exceptions.filter((ref: unknown) =>
									refs.has(ref as string),
								),
							),
						]
					: [],
			},
			view: checkView(m.view),
			placements,
		}
	})

	return {
		source: {
			homeId: str(file.source?.homeId),
			appVersion: str(file.source?.appVersion),
		},
		exportedAt: str(file.exportedAt),
		maps,
		nodes,
	}
}
