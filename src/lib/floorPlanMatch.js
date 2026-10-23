// Floorplan import: propose which node here each node in an export file is.
// The user reviews every proposal before anything is imported.

import { deviceKey } from './meshView.js'

/**
 * A device model ID (manufacturerId-productId-productType), or null. A node
 * interviewed without those IDs has "undefined-undefined-undefined", which
 * must not count as a model.
 */
export function cleanDeviceId(id) {
	return typeof id === 'string' && /^\d+-\d+-\d+$/.test(id) ? id : null
}

/** This network's nodes in the shape matching needs; virtual nodes aren't placed */
export function localNodes(nodes, homeHex) {
	if (!homeHex) return []
	return nodes
		.filter((n) => !n.virtual)
		.map((n) => ({
			key: deviceKey(homeHex, n.id),
			id: n.id,
			name: n.name,
			loc: n.loc,
			deviceId: cleanDeviceId(n.deviceId),
			controller: !!n.isControllerNode,
		}))
}

const norm = (s) => (s ?? '').trim().toLowerCase()
const generic = (name) => !name || /^nodeid \d+$/.test(norm(name))
const LEVELS = { 3: 'certain', 2: 'likely', 1: 'possible' }

/**
 * How strongly a file entry matches a local node:
 *  3 certain  - both are the controller; or same home ID and node ID with
 *               the same deviceId, and the same name or none in the file
 *               (a generic "NodeID 12" or empty name)
 *  2 likely   - same name and same deviceId
 *  1 possible - same deviceId and same location; or same name only
 *  0          - no evidence, or only one of them is a controller
 * Generic names ("NodeID 12") don't count as a name match.
 */
export function matchScore(entry, node, localHome) {
	if (entry.controller || node.controller) {
		return entry.controller && node.controller ? 3 : 0
	}
	const entryDevice = cleanDeviceId(entry.deviceId)
	const sameName =
		!generic(entry.name) && norm(entry.name) === norm(node.name)
	const sameDevice = !!entryDevice && entryDevice === node.deviceId
	const sameLoc = !!norm(entry.loc) && norm(entry.loc) === norm(node.loc)
	if (
		entry.homeId &&
		entry.homeId === localHome &&
		entry.nodeId === node.id &&
		sameDevice &&
		(sameName || generic(entry.name))
	) {
		return 3
	}
	if (sameName && sameDevice) return 2
	if ((sameDevice && sameLoc) || sameName) return 1
	return 0
}

/**
 * Propose one local node per file entry, strongest evidence first:
 * { [ref]: { key, confidence, tied? } }. Each local node is proposed at most
 * once. When an entry's best evidence points at more than one node, or a node
 * is the single best for more than one entry, those are left for the user,
 * with `tied` saying how many nodes matched equally well.
 */
export function proposeMatches(entries, nodes, localHome) {
	const result = Object.fromEntries(
		entries.map((e) => [e.ref, { key: null, confidence: 'none' }]),
	)
	const home = localHome ? localHome.replace(/^0x/, '') : null
	const takenNodes = new Set()
	const doneEntries = new Set()
	for (const level of [3, 2, 1]) {
		const best = new Map() // ref -> node keys at this level
		for (const e of entries) {
			if (doneEntries.has(e.ref)) continue
			const scored = nodes
				.filter((n) => !takenNodes.has(n.key))
				.map((n) => [n.key, matchScore(e, n, home)])
			const top = Math.max(0, ...scored.map(([, s]) => s))
			if (top !== level) continue
			best.set(
				e.ref,
				scored.filter(([, s]) => s === level).map(([k]) => k),
			)
		}
		const claims = new Map() // node key -> refs naming it as their single best
		for (const [ref, keys] of best) {
			if (keys.length !== 1) continue
			claims.set(keys[0], [...(claims.get(keys[0]) ?? []), ref])
		}
		for (const [key, refs] of claims) {
			if (refs.length !== 1) continue
			result[refs[0]] = { key, confidence: LEVELS[level] }
			takenNodes.add(key)
		}
		// entries with ties at this level stay unproposed, with a hint
		for (const [ref, keys] of best) {
			doneEntries.add(ref)
			if (result[ref].key === null) result[ref].tied = keys.length
		}
	}
	return result
}
