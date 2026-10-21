<template>
	<div class="mesh-health">
		<v-card v-if="open" density="compact" class="mesh-health-card">
			<v-card-title class="d-flex align-center text-subtitle-1 py-1">
				Mesh health
				<v-spacer></v-spacer>
				<v-btn
					icon="close"
					size="x-small"
					variant="text"
					@click="open = false"
				></v-btn>
			</v-card-title>
			<v-card-text class="pa-0">
				<v-list v-if="items.length" density="compact" class="py-0">
					<v-list-item
						v-for="item in items"
						:key="item.id"
						@click="$emit('select', item.id)"
					>
						<template #prepend>
							<v-icon :color="colors[item.level]" size="small">{{
								item.level === 'bad' ? 'error' : 'warning'
							}}</v-icon>
						</template>
						<v-list-item-title class="text-body-2">{{
							item.label
						}}</v-list-item-title>
						<v-list-item-subtitle
							v-for="(r, i) in item.reasons"
							:key="i"
							class="text-caption mesh-health-reason"
							>{{ r }}</v-list-item-subtitle
						>
					</v-list-item>
				</v-list>
				<div v-else class="px-4 py-2 text-body-2">
					No problems found.
				</div>
				<div
					v-if="weakHops || oneWay"
					class="px-4 pb-2 text-caption text-medium-emphasis"
				>
					<div v-if="weakHops">
						{{ plural(weakHops, 'weak hop') }} on routes (marked
						"!")
					</div>
					<div v-if="oneWay">
						{{
							plural(
								oneWay,
								'one-way neighbor entry',
								'one-way neighbor entries',
							)
						}}
						(dotted lines)
					</div>
				</div>
				<div class="px-4 pb-2 text-caption text-medium-emphasis">
					Neighbor counts are only judged once neighbor tables are
					known for most of the mesh.
				</div>
			</v-card-text>
		</v-card>
		<!-- stays put under the card, so it closes it again -->
		<v-chip
			:color="worst ? colors[worst] : 'success'"
			variant="elevated"
			:prepend-icon="worst ? 'warning' : 'check_circle'"
			@click="open = !open"
		>
			{{ summary }}
		</v-chip>
	</div>
</template>

<script>
import { HEALTH_COLORS } from '@/lib/meshView.js'
import { plural } from '@/lib/utils.js'

export default {
	name: 'MeshHealthCard',
	props: {
		/** flagged nodes: [{ id, label, level: 'warn'|'bad', reasons }] */
		items: { type: Array, default: () => [] },
		weakHops: { type: Number, default: 0 },
		oneWay: { type: Number, default: 0 },
	},
	emits: ['select'],
	data() {
		return { open: false, colors: HEALTH_COLORS }
	},
	computed: {
		worst() {
			if (this.items.some((i) => i.level === 'bad')) return 'bad'
			return this.items.length ? 'warn' : null
		},
		summary() {
			const n = this.items.length
			if (!n) return 'Mesh health: no problems'
			return `${plural(n, 'node')} need${n === 1 ? 's' : ''} attention`
		},
	},
	methods: { plural },
}
</script>

<style scoped>
.mesh-health {
	position: absolute;
	right: 12px;
	bottom: 12px;
	z-index: 500;
	max-width: 340px;
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	gap: 6px;
}

.mesh-health-card {
	max-height: 50vh;
	overflow-y: auto;
	align-self: stretch;
}

/* reasons wrap instead of being cut to one line (beats Vuetify's
   .v-list-item--one-line clamp) */
.mesh-health-card .mesh-health-reason {
	-webkit-line-clamp: unset;
	line-clamp: unset;
	white-space: normal;
}
</style>
