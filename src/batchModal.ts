import type { App } from "obsidian";
import { FuzzySuggestModal, Modal, TFolder } from "obsidian";

/** Folder picker shared by every "move to…" entry point. */
export class FolderPickerModal extends FuzzySuggestModal<TFolder> {
  constructor(
    app: App,
    private folders: TFolder[],
    private onChoose: (folder: TFolder) => void,
    placeholder = "输入以筛选目录…"
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getItems(): TFolder[] {
    return this.folders;
  }

  getItemText(folder: TFolder): string {
    return folder.isRoot() ? "/（Vault 根目录）" : folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.onChoose(folder);
  }
}

export interface DeletePreviewItem {
  name: string;
  path: string;
  refCount: number;
}

export interface ConfirmDeleteOptions {
  /** Overrides the generated "delete these N images?" heading. */
  title?: string;
  /** Replaces the default "goes to the trash" line. */
  note?: string;
  confirmText?: string;
}

/**
 * Confirmation for single and batch deletes. Lists what is about to go and
 * calls out the items that are still referenced somewhere — the one case
 * where a delete is genuinely hard to undo.
 */
export class ConfirmDeleteModal extends Modal {
  constructor(
    app: App,
    private items: DeletePreviewItem[],
    private onConfirm: () => void,
    private options: ConfirmDeleteOptions = {}
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("ib-confirm");

    const total = this.items.length;
    const referenced = this.items.filter((i) => i.refCount > 0);

    contentEl.createEl("h3", {
      text:
        this.options.title ??
        (total === 1 ? "删除这张图片？" : `删除 ${total} 张图片？`),
    });

    contentEl.createDiv({
      cls: "ib-confirm-note",
      text:
        this.options.note ??
        "文件会被移入系统回收站，不会立即永久销毁。",
    });

    if (referenced.length > 0) {
      const warn = contentEl.createDiv({ cls: "ib-confirm-warn" });
      warn.createDiv({
        cls: "ib-confirm-warn-title",
        text: `其中 ${referenced.length} 张仍被笔记引用`,
      });
      warn.createDiv({
        cls: "ib-confirm-warn-body",
        text: "删除后这些笔记里的嵌入会变成失效链接。",
      });
    }

    if (total > 0) {
      const list = contentEl.createDiv({ cls: "ib-confirm-list" });
      const shown = this.items.slice(0, 60);
      for (const item of shown) {
        const row = list.createDiv({ cls: "ib-confirm-row" });
        row.createSpan({ cls: "ib-confirm-name", text: item.name });
        row.createSpan({
          cls: "ib-confirm-path",
          text: item.path.includes("/")
            ? item.path.slice(0, item.path.lastIndexOf("/"))
            : "/",
        });
        if (item.refCount > 0) {
          row.createSpan({
            cls: "ib-confirm-ref",
            text: `引用 ${item.refCount}`,
          });
        }
      }
      if (this.items.length > shown.length) {
        list.createDiv({
          cls: "ib-confirm-more",
          text: `…以及另外 ${this.items.length - shown.length} 个条目`,
        });
      }
    }

    const actions = contentEl.createDiv({ cls: "ib-confirm-actions" });

    const cancel = actions.createEl("button", { cls: "ib-btn", text: "取消" });
    cancel.addEventListener("click", () => this.close());

    const confirm = actions.createEl("button", {
      cls: "ib-btn is-danger",
      text: this.options.confirmText ?? "移入回收站",
    });
    confirm.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });

    window.setTimeout(() => confirm.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
