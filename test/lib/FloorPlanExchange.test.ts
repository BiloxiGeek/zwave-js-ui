import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_LAYERS, FloorPlans } from '../../api/lib/FloorPlans.ts'
import type { LocalNode } from '../../api/lib/FloorPlanExchange.ts'
import {
	FORMAT,
	FORMAT_VERSION,
	MAX_FILE_BYTES,
	buildExport,
	localNodes,
	parseImport,
} from '../../api/lib/FloorPlanExchange.ts'

// a real 1x1 PNG
const PNG1 = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64',
)
const fresh = async () =>
	new FloorPlans(await mkdtemp(path.join(tmpdir(), 'floorplans-exchange-')))
const K = (n: number) => `zwave:cdfbb3c7:${n}`

// this network, home cdfbb3c7
const node = (
	id: number,
	name: string,
	loc: string,
	deviceId: string,
	extra: Partial<LocalNode> = {},
): LocalNode => ({
	key: K(id),
	id,
	name,
	loc,
	deviceId,
	controller: false,
	...extra,
})
const LOCAL = [
	node(1, 'wopr3', 'Geek Cave', '134-1-90', { controller: true }),
	node(2, 'GeekCave_Lights', 'Geek Cave', '29-12341-17479'),
	node(14, 'Thermostat', 'Hallway', '57-1-17479'),
	node(60, 'Zwift Fan', 'Paincave', '99-1-1'),
]
const json = (obj: unknown) => Buffer.from(JSON.stringify(obj))
const minimal = {
	format: FORMAT,
	version: FORMAT_VERSION,
	maps: [{ name: 'M', widthPx: 10, heightPx: 10, placements: [] }],
	nodes: [],
}

describe('#FloorPlanExchange', () => {
	it('builds device keys from the running network only', () => {
		const BAD = 'undefined-undefined-undefined'
		const nodes = new Map([
			[1, { id: 1, name: 'ctrl', isControllerNode: true }],
			[5, { id: 5, name: 'Lamp', loc: 'Den', deviceId: BAD }],
		])
		expect(localNodes({ homeHex: '0xcdfbb3c7', nodes })).toMatchObject([
			{ key: K(1), controller: true },
			// a node interviewed without its IDs has no model
			{ key: K(5), name: 'Lamp', deviceId: undefined, controller: false },
		])
		expect(localNodes({ homeHex: undefined, nodes })).toEqual([])
		expect(localNodes(undefined)).toEqual([])
	})

	it('round trips maps, leaving unmatched nodes out', async () => {
		const src = await fresh()
		const house = await src.addMap({ name: 'House' })
		await src.setMapImage(house.id, { bytes: PNG1 })
		await src.setMapImage(house.id, { bytes: PNG1, dark: true })
		const yard = await src.addMap({
			name: 'Yard',
			widthPx: 400,
			heightPx: 300,
		})
		await src.updateMap(house.id, {
			widthPx: 3000,
			heightPx: 5100,
			nodes: { start: 'include', exceptions: [K(60)] },
			view: { center: [5, 6], zoom: 1, layers: { ...DEFAULT_LAYERS } },
		})
		await src.setPlacements(house.id, [
			{ deviceKey: K(14), x: 100, y: 200 },
			{ deviceKey: K(2), x: 300, y: 400 },
			{ deviceKey: K(1), x: 1, y: 1 },
		])
		// node 99 is gone from the network
		await src.setPlacements(yard.id, [
			{ deviceKey: K(14), x: 0, y: 0 },
			{ deviceKey: K(99), x: 9, y: 9 },
		])

		const out = await buildExport({
			data: await src.load(),
			nodes: LOCAL,
			imagesDir: src.imagesDir,
			homeId: 'cdfbb3c7',
			appVersion: '11.24.3',
		})
		expect(out).toMatchObject({
			format: FORMAT,
			version: FORMAT_VERSION,
			source: { homeId: 'cdfbb3c7', appVersion: '11.24.3' },
		})
		expect(out.maps.map((m) => m.name)).toEqual(['House', 'Yard'])
		expect(out.maps[0].background.image.type).toBe('image/png')
		expect(out.maps[0].background.darkImage.data).toBeTruthy()
		expect(out.maps[1].background).toBeNull()
		// the manifest covers every placed node and node list exception once
		expect(out.nodes.map((n) => n.name)).toEqual([
			'Zwift Fan',
			'Thermostat',
			'GeekCave_Lights',
			'wopr3',
			null,
		])
		expect(out.nodes[3].controller).toBe(true)
		expect(out.nodes[4]).toMatchObject({ homeId: 'cdfbb3c7', nodeId: 99 })
		expect(out.maps[0].nodes).toEqual({
			start: 'include',
			exceptions: ['n1'],
		})
		expect(JSON.stringify(out.maps)).not.toContain('zwave:')

		// only the chosen maps
		const one = await buildExport({
			data: await src.load(),
			mapIds: [yard.id],
			nodes: LOCAL,
			imagesDir: src.imagesDir,
		})
		expect(one.maps.map((m) => m.name)).toEqual(['Yard'])
		await expect(
			buildExport({
				data: await src.load(),
				mapIds: ['nope'],
				nodes: [],
				imagesDir: src.imagesDir,
			}),
		).rejects.toThrow('No such map')

		// import onto another network that already has a "House"
		const parsed = parseImport(json(out))
		const dst = await fresh()
		await dst.addMap({ name: 'House' })
		const decisions = {
			n1: 'zwave:aaaa:61',
			n2: 'zwave:aaaa:27',
			n3: null,
			n4: 'zwave:aaaa:1',
			n5: null,
		}
		const res = await dst.importMaps(parsed, decisions)
		expect(res.maps.map((m) => m.name)).toEqual([
			'House (imported)',
			'Yard',
		])
		expect(res.placed).toBe(3)
		expect(res.skipped).toMatchObject([
			{ ref: 'n3', name: 'GeekCave_Lights', maps: ['House (imported)'] },
			{ ref: 'n5', nodeId: 99, maps: ['Yard'] },
		])

		const data = await dst.load()
		const [h, y] = res.maps.map((m) => data.maps.find((x) => x.id === m.id))
		expect([h.widthPx, h.heightPx]).toEqual([3000, 5100])
		expect(h.nodes).toEqual({
			start: 'include',
			exceptions: ['zwave:aaaa:61'],
		})
		expect(h.view.center).toEqual([5, 6])
		expect(existsSync(dst.imagePath(h))).toBe(true)
		expect(existsSync(dst.imagePath(h, { dark: true }))).toBe(true)
		expect(h.placements).toEqual([
			{ deviceKey: 'zwave:aaaa:27', x: 100, y: 200 },
			{ deviceKey: 'zwave:aaaa:1', x: 1, y: 1 },
		])
		expect(y.background).toBeNull()
		expect(y.placements).toEqual([
			{ deviceKey: 'zwave:aaaa:27', x: 0, y: 0 },
		])

		// never overwrites
		const none = Object.fromEntries(out.nodes.map((n) => [n.ref, null]))
		const again = await dst.importMaps(parsed, none)
		expect(again.maps[0].name).toBe('House (imported 2)')
		expect(again.placed).toBe(0)
		// every entry needs a decision, one device per entry, and only
		// entries the file has
		await expect(
			dst.importMaps(parsed, { n1: 'zwave:aaaa:27' }),
		).rejects.toThrow('No decision')
		await expect(
			dst.importMaps(
				parsed,
				Object.fromEntries(
					out.nodes.map((n) => [n.ref, 'zwave:aaaa:27']),
				),
			),
		).rejects.toThrow('same device')
		await expect(
			dst.importMaps(parsed, { ...none, n1: 'bogus' }),
		).rejects.toThrow('Bad device')
		await expect(
			dst.importMaps(parsed, { ...none, n9: 'zwave:aaaa:5' }),
		).rejects.toThrow('No node "n9" in the file')
	})

	it('exports a missing picture as none', async () => {
		const src = await fresh()
		const map = await src.addMap({ name: 'House' })
		await src.setMapImage(map.id, { bytes: PNG1 })
		await src.setMapImage(map.id, { bytes: PNG1, dark: true })
		const data = await src.load()
		await rm(src.imagePath(data.maps[0], { dark: true }))
		const out = await buildExport({
			data,
			nodes: [],
			imagesDir: src.imagesDir,
		})
		expect(out.maps[0].background.image).not.toBeNull()
		expect(out.maps[0].background.darkImage).toBeNull()
	})

	it('refuses an export larger than an import may be', async () => {
		const src = await fresh()
		await src.addMap({ name: 'M' })
		const data = await src.load()
		// no pictures, but a manifest that's too large on its own
		data.maps[0].nodes.exceptions = [K(1)]
		const huge = 'x'.repeat(MAX_FILE_BYTES)
		await expect(
			buildExport({
				data,
				nodes: [{ key: K(1), id: 1, name: huge, controller: false }],
				imagesDir: src.imagesDir,
			}),
		).rejects.toThrow('Export fewer maps')
	})

	it('reads version 1 files, which shared backgrounds between maps', () => {
		const img = { type: 'image/png', data: PNG1.toString('base64') }
		const parsed = parseImport(
			json({
				format: FORMAT,
				version: 1,
				backgrounds: [
					{
						ref: 'b1',
						name: 'House',
						widthPx: 1,
						heightPx: 1,
						image: img,
						imageDark: null,
					},
				],
				maps: [
					{
						name: 'Down',
						widthPx: 10,
						heightPx: 10,
						metersPerPixel: null,
						background: {
							ref: 'b1',
							imageRect: { x: 0, y: 0, w: 10, h: 10 },
						},
						placements: [{ ref: 'n1', x: 1, y: 2 }],
					},
					{
						name: 'Up',
						widthPx: 10,
						heightPx: 10,
						background: {
							ref: 'b1',
							imageRect: { x: 1, y: 1, w: 5, h: 5 },
						},
						placements: [],
					},
				],
				nodes: [{ ref: 'n1', name: 'Lamp' }],
			}),
		)
		expect(parsed.maps.map((m) => m.background.imageRect.w)).toEqual([
			10, 5,
		])
		expect(parsed.maps[1].background.image.equals(PNG1)).toBe(true)
		expect(parsed.maps[1].background.darkImage).toBeNull()
		expect(parsed.maps[0].placements).toEqual([{ ref: 'n1', x: 1, y: 2 }])
	})

	it('refuses bad files with a clear reason', () => {
		expect(parseImport(json(minimal)).maps[0].name).toBe('M')
		const bad = (obj: unknown, msg: string) =>
			expect(() =>
				parseImport(
					typeof obj === 'string' ? Buffer.from(obj) : json(obj),
				),
			).toThrow(msg)
		const map = minimal.maps[0]
		bad('not json', 'not JSON')
		bad({ ...minimal, format: 'toposite-map' }, 'wrong format')
		bad({ ...minimal, version: 3 }, "version 3 isn't supported")
		bad({ ...minimal, maps: [] }, 'map list')
		bad({ ...minimal, maps: [{ ...map, widthPx: 0 }] }, 'map size')
		bad(
			{
				...minimal,
				maps: [
					{
						...map,
						background: {
							imageRect: { x: 0, y: 0, w: 1, h: 1 },
							image: {
								data: Buffer.from('<svg/>').toString('base64'),
							},
						},
					},
				],
			},
			"isn't a PNG, JPEG or WebP",
		)
		bad(
			{ ...minimal, maps: [{ ...map, background: { imageRect: {} } }] },
			'imageRect',
		)
		bad(
			{
				...minimal,
				version: 1,
				backgrounds: [],
				maps: [{ ...map, background: { ref: 'b9', imageRect: {} } }],
			},
			'unknown background',
		)
		bad({ ...minimal, nodes: [{ ref: 'a' }, { ref: 'a' }] }, 'unique')
		bad(
			{
				...minimal,
				maps: [{ ...map, placements: [{ ref: 'x', x: 1, y: 1 }] }],
			},
			'unknown node',
		)
		bad(
			{
				...minimal,
				nodes: [{ ref: 'a' }],
				maps: [
					{
						...map,
						placements: [
							{ ref: 'a', x: 1, y: 1 },
							{ ref: 'a', x: 2, y: 2 },
						],
					},
				],
			},
			'same node twice',
		)
		bad(
			{
				...minimal,
				nodes: [{ ref: 'a' }],
				maps: [{ ...map, placements: [{ ref: 'a', x: 'one', y: 1 }] }],
			},
			'invalid coordinates',
		)
	})

	it('drops a background with no pictures and unknown exceptions', () => {
		const parsed = parseImport(
			json({
				...minimal,
				nodes: [{ ref: 'a' }],
				maps: [
					{
						...minimal.maps[0],
						background: {
							imageRect: { x: 0, y: 0, w: 1, h: 1 },
							image: null,
							darkImage: null,
						},
						nodes: {
							start: 'exclude',
							exceptions: ['a', 'a', 'z'],
						},
					},
				],
			}),
		)
		expect(parsed.maps[0].background).toBeNull()
		expect(parsed.maps[0].nodes).toEqual({
			start: 'exclude',
			exceptionRefs: ['a'],
		})
	})
})
