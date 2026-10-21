import "@/styles/index.css"
import { createApp } from "vue"
import DownloadAcceptancePage from "./DownloadAcceptancePage.vue"
import { activateDownloadIdentity, deactivateDownloadIdentity } from "./identity"
import { initializeDownloadAcceptance } from "./runtime"
import type { DownloadAcceptanceSpec } from "./guard"
export async function mountDownloadAcceptance(element: HTMLElement, spec: DownloadAcceptanceSpec): Promise<void> {
  activateDownloadIdentity(spec)
  try { await initializeDownloadAcceptance(spec); createApp(DownloadAcceptancePage, { spec }).mount(element) }
  catch (error) { deactivateDownloadIdentity(); throw error }
}
