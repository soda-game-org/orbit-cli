export interface OrbitManagedModelDescriptor {
  id: string
  label: string
}

/**
 * Package fallback for the managed Orbit route. The authenticated catalog is
 * authoritative when available; this keeps startup UI truthful before login or
 * while the catalog is temporarily unreachable.
 */
export const ORBIT_MANAGED_DEFAULT_MODEL: Readonly<OrbitManagedModelDescriptor> = Object.freeze({
  id: 'deepseek-v4-pro',
  label: 'DeepSeek V4 Pro',
})

type Dynamic = Record<string, any>

export function managedOrbitModelFromCatalog(value: unknown): OrbitManagedModelDescriptor {
  const catalog = value && typeof value === 'object' ? value as Dynamic : {}
  const models = Array.isArray(catalog.models) ? catalog.models : []
  const requested = [
    catalog.default_model_id,
    catalog.defaultModelId,
    catalog.default,
    catalog.defaults?.pro,
    catalog.defaults?.standard,
  ].find((candidate) => typeof candidate === 'string' && candidate.trim())
  const requestedId = typeof requested === 'string' ? requested.trim() : ''
  const model = models.find((candidate: Dynamic) => candidate?.id === requestedId && candidate?.available !== false)
    || models.find((candidate: Dynamic) => typeof candidate?.id === 'string' && candidate.id.trim() && candidate?.available !== false)
  const id = typeof model?.id === 'string' && model.id.trim()
    ? model.id.trim()
    : ORBIT_MANAGED_DEFAULT_MODEL.id
  const label = typeof model?.label === 'string' && model.label.trim()
    ? model.label.trim()
    : id === ORBIT_MANAGED_DEFAULT_MODEL.id
      ? ORBIT_MANAGED_DEFAULT_MODEL.label
      : id
  return { id, label }
}

export function orbitCodingModelDisplay(
  mode: unknown,
  selectedModel: unknown,
  managedModel: OrbitManagedModelDescriptor = ORBIT_MANAGED_DEFAULT_MODEL,
): string {
  const selected = typeof selectedModel === 'string' ? selectedModel.trim() : ''
  if (selected) return mode === 'orbit' && selected === managedModel.id ? managedModel.label : selected
  return mode === 'orbit' ? managedModel.label : 'auto model'
}
