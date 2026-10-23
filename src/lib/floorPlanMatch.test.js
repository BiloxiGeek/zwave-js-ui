import { describe, it, expect } from 'vitest'
import {
	cleanDeviceId,
	localNodes,
	matchScore,
	proposeMatches,
} from './floorPlanMatch.js'

const K = (n) => `zwave:cdfbb3c7:${n}`

// this network, home cdfbb3c7
const node = (id, name, loc, deviceId, extra = {}) => ({
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
	node(61, 'Zwift PC', 'Paincave', '99-1-1'),
]
const entry = (ref, fields) => ({
	ref,
	homeId: null,
	nodeId: null,
	name: null,
	loc: null,
	deviceId: null,
	controller: false,
	...fields,
})

describe('floorPlanMatch', () => {
	it('builds local nodes with clean device IDs, skipping virtual ones', () => {
		const BAD = 'undefined-undefined-undefined'
		expect(cleanDeviceId(BAD)).toBeNull()
		expect(cleanDeviceId('57-1-17479')).toBe('57-1-17479')
		const nodes = [
			{ id: 1, name: 'ctrl', isControllerNode: true },
			{ id: 5, name: 'Lamp', loc: 'Den', deviceId: BAD },
			{ id: 6, virtual: true },
		]
		expect(localNodes(nodes, '0xcdfbb3c7')).toEqual([
			{
				key: K(1),
				id: 1,
				name: 'ctrl',
				loc: undefined,
				deviceId: null,
				controller: true,
			},
			{
				key: K(5),
				id: 5,
				name: 'Lamp',
				loc: 'Den',
				deviceId: null,
				controller: false,
			},
		])
		expect(localNodes(nodes, '')).toEqual([])
	})

	it('scores matches: certain, likely, possible, none', () => {
		const thermo = LOCAL[2]
		const score = (fields, n = thermo, home = 'cdfbb3c7') =>
			matchScore(entry('a', fields), n, home)
		const same = { name: 'Thermostat', deviceId: '57-1-17479' }
		// same network, same node
		expect(score({ homeId: 'cdfbb3c7', nodeId: 14, ...same })).toBe(3)
		// the controller only ever matches the controller
		expect(score({ controller: true, name: 'old' }, LOCAL[0])).toBe(3)
		expect(score({ controller: true, ...same })).toBe(0)
		expect(score({ name: 'wopr3' }, LOCAL[0])).toBe(0)
		// same network and node, never named: certain on the model alone
		const unnamed = { ...thermo, name: 'NodeID 14' }
		const ids = { homeId: 'cdfbb3c7', nodeId: 14, deviceId: '57-1-17479' }
		expect(score({ ...ids, name: 'NodeID 14' }, unnamed)).toBe(3)
		expect(score({ ...ids, name: null })).toBe(3)
		// ...but a real name that differs is worth a look
		expect(score({ ...ids, name: 'Old thermostat' })).toBe(0)
		// and a generic name on another network proves nothing
		expect(score({ ...ids, homeId: 'aaaa', name: 'NodeID 14' })).toBe(0)
		// other network, same name and model
		expect(
			score({ homeId: 'aaaa', nodeId: 27, ...same, name: 'thermostat ' }),
		).toBe(2)
		// same model and location, or same name only
		expect(score({ deviceId: '57-1-17479', loc: 'hallway' })).toBe(1)
		expect(score({ name: 'Thermostat' })).toBe(1)
		// generic names never match, a model alone is no evidence
		expect(
			score(
				{ name: 'NodeID 14', deviceId: '1-1-1' },
				{ ...thermo, name: 'NodeID 14' },
				'x',
			),
		).toBe(0)
		expect(score({ deviceId: '57-1-17479' })).toBe(0)
		// an incomplete device ID in the file is no model
		const blank = { ...thermo, deviceId: null }
		expect(
			score({ deviceId: 'undefined-undefined-undefined' }, blank),
		).toBe(0)
	})

	it('proposes one local node per entry and leaves ties to the user', () => {
		const m = proposeMatches(
			[
				entry('t', {
					homeId: 'cdfbb3c7',
					nodeId: 14,
					name: 'Thermostat',
					deviceId: '57-1-17479',
				}),
				entry('l', {
					homeId: 'ffff',
					nodeId: 9,
					name: 'GeekCave_Lights',
					deviceId: '29-12341-17479',
				}),
				// two Paincave 99-1-1 nodes: a tie
				entry('f', { deviceId: '99-1-1', loc: 'Paincave' }),
				entry('c', { controller: true, name: 'old controller' }),
				entry('x', { name: 'Garage Door' }),
			],
			LOCAL,
			'0xcdfbb3c7',
		)
		expect(m.t).toEqual({ key: K(14), confidence: 'certain' })
		expect(m.l).toEqual({ key: K(2), confidence: 'likely' })
		expect(m.f).toEqual({ key: null, confidence: 'none', tied: 2 })
		expect(m.c).toEqual({ key: K(1), confidence: 'certain' })
		expect(m.x).toEqual({ key: null, confidence: 'none' })

		// two entries naming the same node as their only best: neither gets it
		const twice = proposeMatches(
			[
				entry('a', { name: 'Thermostat' }),
				entry('b', { name: 'Thermostat' }),
			],
			LOCAL,
			'cdfbb3c7',
		)
		expect([twice.a.key, twice.b.key]).toEqual([null, null])

		// a node taken at a stronger level isn't offered again lower down
		const once = proposeMatches(
			[
				entry('a', {
					homeId: 'cdfbb3c7',
					nodeId: 14,
					name: 'Thermostat',
					deviceId: '57-1-17479',
				}),
				entry('b', { name: 'Thermostat' }),
			],
			LOCAL,
			'cdfbb3c7',
		)
		expect([once.a.key, once.b.key]).toEqual([K(14), null])
	})
})
