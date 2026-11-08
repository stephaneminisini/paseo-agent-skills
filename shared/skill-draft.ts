export interface DraftFile {
  path: string;
  content: string;
}

/** An editor draft of a local skill. Operations return new drafts and never mutate. */
export interface SkillDraft {
  name: string;
  /** Local version the draft started from. */
  baseVersion: number;
  files: DraftFile[];
  /** Folders added in the editor that hold no file yet; they are never saved. */
  emptyFolders: string[];
  original: DraftFile[];
}

export type DraftResult = { ok: true; draft: SkillDraft } | { ok: false; error: string };

export interface TreeNode {
  name: string;
  path: string;
  kind: "file" | "folder";
  children: TreeNode[];
}

const RESERVED = new Set([".agent-skill.json", ".langfuse-skill.json"]);

export function openDraft(name: string, version: number, files: DraftFile[]): SkillDraft {
  return { name, baseVersion: version, files: [...files], emptyFolders: [], original: [...files] };
}

function signature(files: DraftFile[]): string {
  return JSON.stringify([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}

/** Whether the files differ from the ones the draft opened with; empty folders do not count. */
export function isDirty(draft: SkillDraft): boolean {
  return signature(draft.files) !== signature(draft.original);
}

/** An error message for a path the store would refuse, or null when it is acceptable. */
export function checkPath(path: string): string | null {
  const segments = path.split("/");
  const bad =
    path.length === 0 ||
    path.includes("\\") ||
    path.includes("\0") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    RESERVED.has(path);
  return bad ? `"${path}" is not a valid file path.` : null;
}

function folderPaths(draft: SkillDraft): Set<string> {
  const folders = new Set(draft.emptyFolders);
  for (const file of draft.files) {
    const segments = file.path.split("/");
    for (let index = 1; index < segments.length; index += 1) folders.add(segments.slice(0, index).join("/"));
  }
  return folders;
}

/** Why `path` cannot be created in `draft`, or null. */
function conflict(draft: SkillDraft, path: string): string | null {
  const invalid = checkPath(path);
  if (invalid) return invalid;
  if (draft.files.some((file) => file.path === path) || folderPaths(draft).has(path)) return `${path} already exists.`;
  const segments = path.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const parent = segments.slice(0, index).join("/");
    if (draft.files.some((file) => file.path === parent)) return `${parent} is a file.`;
  }
  return null;
}

function withoutCoveredFolders(emptyFolders: string[], files: DraftFile[]): string[] {
  return emptyFolders.filter((folder) => !files.some((file) => file.path.startsWith(`${folder}/`)));
}

export function addFile(draft: SkillDraft, path: string): DraftResult {
  const error = conflict(draft, path);
  if (error) return { ok: false, error };
  const files = [...draft.files, { path, content: "" }];
  return { ok: true, draft: { ...draft, files, emptyFolders: withoutCoveredFolders(draft.emptyFolders, files) } };
}

export function addFolder(draft: SkillDraft, path: string): DraftResult {
  const error = conflict(draft, path);
  if (error) return { ok: false, error };
  return { ok: true, draft: { ...draft, emptyFolders: [...draft.emptyFolders, path] } };
}

function isUnder(path: string, target: string): boolean {
  return path === target || path.startsWith(`${target}/`);
}

/** Renames a file, or a folder with everything under it. */
export function renamePath(draft: SkillDraft, from: string, to: string): DraftResult {
  if (from === to) return { ok: true, draft };
  const error = conflict(draft, to);
  if (error) return { ok: false, error };
  if (isUnder(to, from)) return { ok: false, error: `${to} is inside ${from}.` };
  const move = (path: string) => (isUnder(path, from) ? to + path.slice(from.length) : path);
  const files = draft.files.map((file) => ({ ...file, path: move(file.path) }));
  const emptyFolders = draft.emptyFolders.map(move);
  return { ok: true, draft: { ...draft, files, emptyFolders } };
}

/** Removes a file, or a folder with everything under it. */
export function removePath(draft: SkillDraft, path: string): DraftResult {
  const files = draft.files.filter((file) => !isUnder(file.path, path));
  const emptyFolders = draft.emptyFolders.filter((folder) => !isUnder(folder, path));
  return { ok: true, draft: { ...draft, files, emptyFolders } };
}

export function setContent(draft: SkillDraft, path: string, content: string): SkillDraft {
  return { ...draft, files: draft.files.map((file) => (file.path === path ? { ...file, content } : file)) };
}

/** A folder tree of `files` plus `emptyFolders`: folders first, then files, each sorted by name. */
export function buildTree(files: Array<{ path: string }>, emptyFolders: string[] = []): TreeNode[] {
  const root: TreeNode = { name: "", path: "", kind: "folder", children: [] };
  function folder(segments: string[]): TreeNode {
    let node = root;
    segments.forEach((segment, index) => {
      let child = node.children.find((candidate) => candidate.kind === "folder" && candidate.name === segment);
      if (!child) {
        child = { name: segment, path: segments.slice(0, index + 1).join("/"), kind: "folder", children: [] };
        node.children.push(child);
      }
      node = child;
    });
    return node;
  }
  for (const empty of emptyFolders) folder(empty.split("/"));
  for (const file of files) {
    const segments = file.path.split("/");
    const name = segments.pop() ?? file.path;
    folder(segments).children.push({ name, path: file.path, kind: "file", children: [] });
  }
  function sort(nodes: TreeNode[]): TreeNode[] {
    return nodes
      .map((node) => ({ ...node, children: sort(node.children) }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1));
  }
  return sort(root.children);
}
