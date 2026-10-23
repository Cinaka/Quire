// Real installed Dexie, not a fake implementation. Only adapter subscriptions are counted.
import Dexie, { liveQuery as actualLiveQuery } from 'dexie'
export default Dexie
export const subscriptions = { active: 0, created: 0 }
export function liveQuery(query) {
  return { subscribe(observer) {
    subscriptions.active++; subscriptions.created++
    let sub
    try { sub = actualLiveQuery(query).subscribe(observer) }
    catch (error) { subscriptions.active--; throw error }
    let closed = false
    return { unsubscribe() { if (closed) return; closed = true; subscriptions.active--; sub.unsubscribe() } }
  } }
}
