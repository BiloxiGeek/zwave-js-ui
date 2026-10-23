<template>
	<v-dialog v-model="_value" max-width="900px" :persistent="running">
		<v-card v-if="result">
			<v-card-title class="text-h5">Not imported</v-card-title>
			<v-card-text>
				<p class="mb-2">
					{{ importedSummary }} These devices in the file weren't
					matched to a node here, so their positions were left out.
					Place them by hand once you know which nodes they are.
				</p>
				<v-table density="compact">
					<thead>
						<tr>
							<th>In the file</th>
							<th>Details</th>
							<th>Was on</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="e in result.skipped" :key="e.ref">
							<td>{{ e.name || 'Unnamed device' }}</td>
							<td class="text-caption">
								{{ details(e) }}
							</td>
							<td class="text-caption">
								{{ e.maps.join(', ') }}
							</td>
						</tr>
					</tbody>
				</v-table>
			</v-card-text>
			<v-card-actions>
				<v-btn
					variant="text"
					prepend-icon="download"
					@click="saveSkipped"
					>Save list</v-btn
				>
				<v-spacer></v-spacer>
				<v-btn color="primary" variant="flat" @click="_value = false"
					>Close</v-btn
				>
			</v-card-actions>
		</v-card>
		<v-card v-else-if="content">
			<v-card-title class="text-h5">Import floorplans</v-card-title>
			<v-card-subtitle>
				{{ mapsSummary }}
				<span v-if="exportedAt"> · exported {{ exportedAt }}</span>
			</v-card-subtitle>
			<v-card-text>
				<p class="mb-2">
					Pick the node each device in the file is here. Devices you
					don't import are listed when the import is done, with what
					the file says about them. Existing maps are never changed,
					the maps are added.
				</p>
				<v-table density="compact">
					<thead>
						<tr>
							<th>In the file</th>
							<th>Match</th>
							<th style="width: 350px">Node here</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="e in entries" :key="e.ref">
							<td>
								<div>
									{{ e.name || 'Unnamed device' }}
									<span
										v-if="e.controller"
										class="text-caption"
										>(controller)</span
									>
								</div>
								<div class="text-caption text-medium-emphasis">
									{{ details(e) }}
								</div>
							</td>
							<td>
								<v-chip
									size="small"
									:color="confidenceColor(e)"
									v-tooltip="confidenceHint(e)"
									>{{ confidenceLabel(e) }}</v-chip
								>
							</td>
							<td>
								<v-autocomplete
									v-model="matches[e.ref]"
									:items="choices"
									:item-props="itemProps(e.ref)"
									density="compact"
									variant="outlined"
									hide-details
								></v-autocomplete>
							</td>
						</tr>
					</tbody>
				</v-table>
				<v-alert
					v-if="duplicate"
					type="error"
					density="compact"
					class="mt-3"
					>{{ duplicate }} is chosen for more than one device</v-alert
				>
			</v-card-text>
			<v-card-actions>
				<span class="text-caption ml-2">
					{{ matchedCount }} to import ·
					{{ entries.length - matchedCount }} not imported
				</span>
				<v-spacer></v-spacer>
				<v-btn :disabled="running" @click="_value = false"
					>Cancel</v-btn
				>
				<v-btn
					color="primary"
					variant="flat"
					:loading="running"
					:disabled="!!duplicate"
					@click="commit"
					>Import</v-btn
				>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script>
import { mapState } from 'pinia'
import useBaseStore from '@/stores/base.js'
import ConfigApis from '@/apis/ConfigApis.js'
import InstancesMixin from '@/mixins/InstancesMixin.js'
import { download } from '@/lib/utils'
import { localNodes, proposeMatches } from '@/lib/floorPlanMatch.js'

const CONFIDENCE = {
	certain: ['Certain', 'success'],
	likely: ['Likely', 'primary'],
	possible: ['Possible', 'warning'],
}

export default {
	name: 'DialogFloorPlanImport',
	mixins: [InstancesMixin],
	props: {
		modelValue: { type: Boolean, default: false },
		/** the chosen export file */
		file: { type: Object, default: null },
		/** its parsed contents, checked by the server on import */
		content: { type: Object, default: null },
	},
	emits: ['update:modelValue', 'imported'],
	data() {
		return { matches: {}, proposals: {}, running: false, result: null }
	},
	computed: {
		...mapState(useBaseStore, ['nodes', 'appInfo']),
		_value: {
			get() {
				return this.modelValue
			},
			set(val) {
				this.$emit('update:modelValue', val)
			},
		},
		local() {
			return localNodes(this.nodes, this.appInfo.homeHex)
		},
		entries() {
			return (this.content?.nodes ?? []).map((e) => ({
				...e,
				...this.proposals[e.ref],
			}))
		},
		choices() {
			return [
				{ title: "Don't import", value: null },
				...this.local.map((n) => ({
					title: `${n.name || `NodeID ${n.id}`} (node ${n.id})${n.loc ? ` · ${n.loc}` : ''}`,
					value: n.key,
				})),
			]
		},
		mapsSummary() {
			return (this.content?.maps ?? [])
				.map((m) => {
					const n = m.placements?.length ?? 0
					return `${m.name} (${n} node${n === 1 ? '' : 's'})`
				})
				.join(', ')
		},
		exportedAt() {
			const at = this.content?.exportedAt
			const d = new Date(at)
			return isNaN(d) ? at : d.toLocaleString()
		},
		importedSummary() {
			const { maps, placed } = this.result
			return `Imported ${maps.length} map${maps.length === 1 ? '' : 's'} with ${placed} node${placed === 1 ? '' : 's'} placed.`
		},
		matchedCount() {
			return Object.values(this.matches).filter(Boolean).length
		},
		/** name of a node chosen twice, if any */
		duplicate() {
			const seen = new Set()
			for (const key of Object.values(this.matches)) {
				if (!key) continue
				if (seen.has(key)) {
					return this.choices.find((c) => c.value === key)?.title
				}
				seen.add(key)
			}
			return null
		},
	},
	watch: {
		content: {
			immediate: true,
			handler(content) {
				const entries = content?.nodes ?? []
				this.result = null
				this.proposals = proposeMatches(
					entries,
					this.local,
					this.appInfo.homeHex,
				)
				this.matches = Object.fromEntries(
					entries.map((e) => [e.ref, this.proposals[e.ref].key]),
				)
			},
		},
	},
	methods: {
		details(e) {
			return [
				e.loc,
				e.productLabel,
				e.manufacturer,
				e.deviceId && `model ${e.deviceId}`,
				e.nodeId != null && `node ${e.nodeId}`,
			]
				.filter(Boolean)
				.join(' · ')
		},
		/** the proposal's confidence while the user keeps it */
		proposed(e) {
			return e.key && this.matches[e.ref] === e.key ? e.confidence : null
		},
		confidenceLabel(e) {
			const c = this.proposed(e)
			if (c) return CONFIDENCE[c][0]
			if (this.matches[e.ref]) return 'Your pick'
			return e.tied ? `${e.tied} candidates` : 'No match'
		},
		confidenceColor(e) {
			const c = this.proposed(e)
			if (c) return CONFIDENCE[c][1]
			return this.matches[e.ref] ? 'primary' : undefined
		},
		confidenceHint(e) {
			const c = this.proposed(e)
			if (c === 'certain') {
				return 'Same network and node, or both are the controller'
			}
			if (c === 'likely') return 'Same name and device model'
			if (c === 'possible') {
				return 'Same model and location, or the same name'
			}
			if (e.tied && !this.matches[e.ref]) {
				return `${e.tied} nodes match equally well, pick one`
			}
			return ''
		},
		/** grey out nodes another device already has */
		itemProps(ref) {
			return (item) => {
				const takenBy = Object.entries(this.matches).find(
					([r, key]) => r !== ref && key && key === item.value,
				)
				return {
					title: item.title,
					subtitle: takenBy ? 'chosen for another device' : undefined,
				}
			}
		},
		async commit() {
			this.running = true
			try {
				const res = await ConfigApis.importFloorPlans(
					this.file,
					this.matches,
				)
				if (!res.success) throw Error(res.message)
				this.$emit('imported', res.data)
				if (res.data.skipped.length) {
					this.result = res.data
				} else {
					this._value = false
				}
			} catch (error) {
				this.showSnackbar(`Import failed: ${error.message}`, 'error')
			} finally {
				this.running = false
			}
		},
		/** the list as a text file, to sort out later */
		saveSkipped() {
			const lines = this.result.skipped.map(
				(e) =>
					`${e.name || 'Unnamed device'} | ${this.details(e)} | was on ${e.maps.join(', ')}`,
			)
			const blob = new Blob([`${lines.join('\n')}\n`], {
				type: 'text/plain',
			})
			download(
				URL.createObjectURL(blob),
				`${this.file?.name?.replace(/\.json$/i, '') || 'floorplan'}_not_imported.txt`,
			)
		},
	},
}
</script>
