import "@/styles/index.css"
import { createApp } from "vue"
import ResourceAcceptancePage from "./ResourceAcceptancePage.vue"
import { activateResourceIdentity, deactivateResourceIdentity } from "./identity"
import { initializeResourceAcceptance } from "./runtime"
import type { ResourceAcceptanceSpec } from "./guard"
export async function mountResourceAcceptance(element: HTMLElement, spec: ResourceAcceptanceSpec): Promise<void> {
  activateResourceIdentity(spec)
  try { await initializeResourceAcceptance(spec); createApp(ResourceAcceptancePage, { spec }).mount(element) }
  catch (error) { deactivateResourceIdentity(); throw error }
}
