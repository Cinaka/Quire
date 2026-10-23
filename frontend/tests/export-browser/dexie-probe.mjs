// Real installed Dexie, not a fake implementation. Only adapter subscriptions are counted.
import Dexie, { liveQuery as actualLiveQuery } from 'dexie'
export default observedDexie
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
// Count only the adapter's global committed-mutation listeners, not Dexie's own hooks.
const contentListeners = new Set()
subscriptions.contentActive = 0
subscriptions.contentCreated = 0
const observedDexie = new Proxy(Dexie, { get(target, key, receiver) {
  if (key !== 'on') return Reflect.get(target, key, receiver)
  return (name, listener) => {
    if (name !== 'storagemutated') return listener ? Dexie.on(name, listener) : Dexie.on(name)
    if (listener) {
      Dexie.on(name, listener); contentListeners.add(listener)
      subscriptions.contentCreated++; subscriptions.contentActive = contentListeners.size
      return
    }
    return { unsubscribe(fn) { Dexie.on(name).unsubscribe(fn); contentListeners.delete(fn); subscriptions.contentActive = contentListeners.size } }
  }
} })
