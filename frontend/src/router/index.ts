import { createRouter, createWebHistory } from "vue-router"

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "home", component: () => import("@/views/HomeView.vue") },
    { path: "/entry/new", name: "entry-new", component: () => import("@/views/EntryEditView.vue") },
    { path: "/entry/:id", name: "entry-edit", component: () => import("@/views/EntryEditView.vue") },
    { path: "/list", name: "list", component: () => import("@/views/ListView.vue") },
    { path: "/schedules", name: "schedules", component: () => import("@/views/ScheduleView.vue") },
    { path: "/settings", name: "settings", component: () => import("@/views/SettingsView.vue") },
    { path: "/trash", name: "trash",  component: () => import("@/views/TrashView.vue") },
    { path: "/:pathMatch(.*)*", name: "404", component: () => import("@/views/NotFoundView.vue") },
  ],
  scrollBehavior: () => ({ top: 0 }),
})

export default router
