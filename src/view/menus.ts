/* Context menus for image cards and for folder rows / cards. */

import { Menu, Notice } from "obsidian";
import type { FolderNode, ImageEntry } from "../types";
import { extOf, openWithOS, revealInOS } from "../utils";
import { imagesUnder } from "../exporter";
import { FolderPickerModal } from "../batchModal";
import type { ViewPart } from "./viewTypes";

export interface MenuPart {
  showCardMenu(evt: MouseEvent, entry: ImageEntry): void;
  showFolderMenu(evt: MouseEvent, node: FolderNode): void;
}

export const menuPart: ViewPart<MenuPart> = {
  showCardMenu(evt: MouseEvent, entry: ImageEntry): void {
    const menu = new Menu();
    // Right-clicking a card that belongs to the current selection acts on the
    // whole selection; anything else acts on this card alone — and nothing
    // here mutates the selection. Opening a menu must never be a way to
    // accidentally select (or silently re-select) something.
    const targets = this.selection.has(entry.path) ? this.selectedEntries() : [entry];
    const multi = targets.length > 1;

    if (multi) {
      menu.addItem((i) =>
        i.setTitle(`已选中 ${targets.length} 项`).setIcon("check-check").setDisabled(true)
      );
      menu.addSeparator();
      menu.addItem((i) =>
        i.setTitle("批量移动…").setIcon("folder-input").onClick(() => this.promptMoveSelection())
      );
      menu.addItem((i) =>
        i
          .setTitle("批量删除")
          .setIcon("trash")
          .setWarning(true)
          .onClick(() => void this.deleteSelection())
      );
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle("复制嵌入引用")
          .setIcon("link")
          .onClick(() => {
            void navigator.clipboard.writeText(
              targets.map((e) => `![[${e.path}]]`).join("\n")
            );
            new Notice(`已复制 ${targets.length} 条嵌入引用`);
          })
      );
      menu.addItem((i) =>
        i
          .setTitle("复制文件路径")
          .setIcon("copy")
          .onClick(() => {
            void navigator.clipboard.writeText(targets.map((e) => e.path).join("\n"));
            new Notice(`已复制 ${targets.length} 条文件路径`);
          })
      );
      menu.showAtMouseEvent(evt);
      return;
    }

    const copy = (text: string, toast: string) => () => {
      void navigator.clipboard.writeText(text);
      new Notice(toast);
    };
    const moveTo = () =>
      new FolderPickerModal(this.app, this.store.listFolders(), (folder) => {
        void this.moveImages([entry.path], folder.isRoot() ? "" : folder.path, true);
      }).open();

    // PNG bytes can go straight onto the clipboard; anything else is re-encoded
    // through a canvas, because Chromium's clipboard only accepts image/png.
    const copyImage = async () => {
      try {
        const buf = await this.app.vault.readBinary(entry.file);
        let blob: Blob | null;
        if (extOf(entry.name) === "png") {
          blob = new Blob([buf], { type: "image/png" });
        } else {
          const bmp = await createImageBitmap(new Blob([buf]));
          const canvas = document.createElement("canvas");
          canvas.width = bmp.width;
          canvas.height = bmp.height;
          canvas.getContext("2d")?.drawImage(bmp, 0, 0);
          blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
          bmp.close();
        }
        if (!blob) throw new Error("png encode failed");
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        new Notice("已复制图像");
      } catch (err) {
        console.error(err);
        new Notice(`复制失败：${entry.name} —— 无法写入剪贴板`);
      }
    };

    menu.addItem((i) =>
      i.setTitle("查看详情").setIcon("info").onClick(() => this.openDetail(entry.path))
    );
    menu.addItem((i) =>
      i.setTitle("用系统默认应用打开").setIcon("external-link").onClick(() => openWithOS(this.app, entry.path))
    );
    menu.addItem((i) =>
      i
        .setTitle("在系统资源管理器中显示")
        .setIcon("folder-open")
        .onClick(() => revealInOS(this.app, entry.path))
    );

    menu.addSeparator();

    menu.addItem((i) =>
      i.setTitle("重命名…").setIcon("pencil").onClick(() => this.promptRename(entry))
    );
    menu.addItem((i) => i.setTitle("移动到…").setIcon("folder-input").onClick(moveTo));
    menu.addItem((i) =>
      i
        .setTitle(this.selection.has(entry.path) ? "取消选中" : "选中")
        .setIcon("square-check")
        .onClick(() => this.toggleSelect(entry.path))
    );

    menu.addSeparator();

    menu.addItem((i) =>
      i.setTitle("复制文件路径").setIcon("copy").onClick(copy(entry.path, "已复制文件路径"))
    );
    menu.addItem((i) =>
      i
        .setTitle("复制嵌入引用")
        .setIcon("link")
        .onClick(copy(`![[${entry.path}]]`, "已复制嵌入引用"))
    );
    menu.addItem((i) =>
      i.setTitle("复制图像").setIcon("clipboard-copy").onClick(() => void copyImage())
    );

    menu.addSeparator();

    menu.addItem((i) =>
      i
        .setTitle("删除")
        .setIcon("trash")
        .setWarning(true)
        .onClick(() => void this.deleteImages([entry]))
    );

    menu.showAtMouseEvent(evt);
  },

  /** Menu shared by folder cards and tree rows. */
  showFolderMenu(evt: MouseEvent, node: FolderNode): void {
    const menu = new Menu();
    const isRoot = node.path === "";

    menu.addItem((i) => i.setTitle("打开目录").setIcon("folder-open").onClick(() => this.enter(node.path)));
    menu.addSeparator();

    menu.addItem((i) =>
      i
        .setTitle("新建子目录…")
        .setIcon("folder-plus")
        .onClick(() => this.promptCreateFolder(node.path))
    );
    menu.addItem((i) =>
      i
        .setTitle("粘贴剪贴板图片到此处")
        .setIcon("clipboard-paste")
        .onClick(() => void this.importFromSystemClipboard(node.path))
    );

    menu.addSeparator();

    // Exporting a folder that holds no images (directly or below) would produce
    // an empty archive with a "success" toast, which reads as a bug.
    const exportable = imagesUnder(this.store.scanImages(), node.path).length > 0;
    menu.addItem((i) =>
      i
        .setTitle("导出为 ZIP…")
        .setIcon("download")
        .setDisabled(!exportable)
        .onClick(() => void this.plugin.openZipExport(node.path))
    );

    menu.addSeparator();

    menu.addItem((i) =>
      i
        .setTitle("重命名…")
        .setIcon("pencil")
        .setDisabled(isRoot)
        .onClick(() => this.promptRenameFolder(node))
    );
    menu.addItem((i) =>
      i
        .setTitle("移动到…")
        .setIcon("folder-input")
        .setDisabled(isRoot)
        .onClick(() => {
          new FolderPickerModal(this.app, this.store.listFolders(), (target) => {
            void this.moveFolder(node.path, target.isRoot() ? "" : target.path, true);
          }).open();
        })
    );
    menu.addItem((i) =>
      i
        .setTitle("在系统资源管理器中显示")
        .setIcon("folder-open")
        .setDisabled(isRoot)
        .onClick(() => revealInOS(this.app, node.path))
    );
    menu.addItem((i) =>
      i
        .setTitle("复制文件路径")
        .setIcon("copy")
        .setDisabled(isRoot)
        .onClick(() => {
          void navigator.clipboard.writeText(node.path);
          new Notice("已复制文件路径");
        })
    );

    menu.addSeparator();

    menu.addItem((i) =>
      i
        .setTitle("删除目录")
        .setIcon("trash")
        .setWarning(true)
        .setDisabled(isRoot)
        .onClick(() => this.promptDeleteFolder(node))
    );

    menu.showAtMouseEvent(evt);
  },
};
