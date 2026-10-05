/* Minimal single-input prompt, since Obsidian exposes no public one. */

import type { App } from "obsidian";
import { Modal } from "obsidian";

export class PromptModal extends Modal {
  constructor(
    app: App,
    private heading: string,
    private initial: string,
    private onSubmit: (value: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.heading });

    const input = contentEl.createEl("input", {
      cls: "ib-prompt-input",
      attr: { type: "text" },
    });
    input.value = this.initial;

    const submit = () => {
      const value = input.value.trim();
      if (!value) return;
      this.close();
      this.onSubmit(value);
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });

    const btn = contentEl.createEl("button", { text: "确定", cls: "ib-btn mod-cta" });
    btn.addEventListener("click", submit);

    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
