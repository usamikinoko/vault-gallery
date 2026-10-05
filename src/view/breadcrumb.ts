/* The path breadcrumb above the grid. Each segment is also a drop target. */

import type { FolderNode } from "../types";
import type { ViewPart } from "./viewTypes";

export interface BreadcrumbPart {
  renderCrumb(): void;
}

export const breadcrumbPart: ViewPart<BreadcrumbPart> = {
  renderCrumb(): void {
    this.crumbEl.empty();
    const tree = this.store.buildTree();
    if (!tree) return;

    const chain: FolderNode[] = [];
    const find = (node: FolderNode, target: string, acc: FolderNode[]): boolean => {
      acc.push(node);
      if (node.path === target) return true;
      for (const child of node.children) {
        if (find(child, target, acc)) return true;
      }
      acc.pop();
      return false;
    };
    if (!find(tree, this.currentPath, chain)) {
      chain.length = 0;
      chain.push(tree);
    }

    chain.forEach((node, i) => {
      const isLast = i === chain.length - 1;
      const seg = this.crumbEl.createSpan({
        cls: isLast ? "ib-crumb-item is-current" : "ib-crumb-item is-link",
        text: node.name,
      });
      if (isLast) return;
      seg.addEventListener("click", () => this.enter(node.path));
      this.makeFolderDropTarget(seg, node.path);
      this.crumbEl.createSpan({ cls: "ib-crumb-sep", text: "/" });
    });
  },
};
