import i18n from "i18next";
import { initReactI18next } from "react-i18next";

const en = {
  common: {
    start: "Start Swarm",
    stop: "Stop",
    cancel: "Cancel",
    save: "Save",
    edit: "Edit",
    delete: "Delete",
    confirm: "Confirm",
    close: "Close",
  },
  swarm: {
    running: "Running",
    idle: "Idle",
    blocked: "Blocked",
    beforeLoop: "Before Loop",
    afterLoop: "After Loop",
    planningDialog: "Planning (Dialog)",
    planningDebate: "Planning (Debate)",
    readyToStart: "Ready to Start",
    unknown: "Unknown",
    workers: "workers",
    chat: "Chat",
    topology: "Topology",
  },
  config: {
    title: "Configuration",
    workers: "Workers",
    cloners: "Cloners",
    model: "Model",
    save: "Save Changes",
    saved: "Saved",
  },
};

i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
