import "@/styles/index.css"
import { createApp } from "vue"
import AcceptancePage from "./AcceptancePage.vue"
import { initializeAcceptance } from "./fixtures"
import type { AcceptanceSpec } from "./guard"
export async function mountAcceptance(element: HTMLElement, spec: AcceptanceSpec): Promise<void> {
  await initializeAcceptance(spec)
  createApp(AcceptancePage, { spec }).mount(element)
}
