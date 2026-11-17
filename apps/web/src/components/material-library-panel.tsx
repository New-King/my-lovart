"use client";

import { deleteMaterial, fetchMaterials, uploadMaterial } from "@/lib/materials-api";
import { guessMimeTypeFromUrl, setChatImageDragData } from "@/lib/chat-canvas-drag";
import type { LibraryMaterial } from "@/lib/public-materials";
import { Loader2, Plus, Search, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type Props = {
  /** manage：可以上传、删除；select：只能挑选加入对话。 */
  mode: "manage" | "select";
  onSelect: (material: LibraryMaterial) => void;
  onClose: () => void;
};

type CardProps = {
  material: LibraryMaterial;
  canDelete: boolean;
  onSelect: (material: LibraryMaterial) => void;
  onDelete?: (material: LibraryMaterial) => void;
};

function MaterialCard({ material, canDelete, onSelect, onDelete }: CardProps) {
  const mimeType = material.mimeType || guessMimeTypeFromUrl(material.url);

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => onSelect(material)}
        draggable
        onDragStart={(event) =>
          setChatImageDragData(event, {
            url: material.url,
            title: material.name,
            mimeType,
            ...(material.width > 0 ? { width: material.width } : {}),
            ...(material.height > 0 ? { height: material.height } : {}),
          })
        }
        className="w-full cursor-grab overflow-hidden rounded-lg border border-line bg-surface text-left transition-colors hover:border-accent/30 active:cursor-grabbing"
      >
        <img
          src={material.url}
          alt={material.name}
          draggable={false}
          className="aspect-[4/3] w-full object-cover transition-opacity group-hover:opacity-90"
        />
        <div className="px-1.5 py-1">
          <p className="truncate text-[11.5px] text-ink">{material.name}</p>
          <p className="text-[10px] text-faint">单击加入对话 · 拖到画布</p>
        </div>
      </button>

      <span
        aria-hidden
        className="pointer-events-none absolute left-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-ink/65 text-white opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover:opacity-100"
      >
        <Plus className="size-3.5" strokeWidth={2} />
      </span>

      {canDelete && onDelete && (
        <button
          type="button"
          onClick={() => onDelete(material)}
          aria-label={`删除 ${material.name}`}
          className="absolute right-1 top-1 grid size-6 place-items-center rounded-md bg-canvas/85 text-muted opacity-0 shadow-sm transition-all hover:bg-canvas hover:text-danger group-hover:opacity-100 max-sm:opacity-100"
        >
          <Trash2 className="size-3" strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}

export function MaterialLibraryPanel({ mode, onSelect, onClose }: Props) {
  const [materials, setMaterials] = useState<LibraryMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(0);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const canManage = mode === "manage";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchMaterials()
      .then((items) => {
        if (!cancelled) setMaterials(items);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "素材库加载失败");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) {
      setError("只支持图片素材（PNG/JPEG/WebP/GIF）");
      return;
    }
    setError(null);
    setUploading((value) => value + images.length);
    for (const file of images) {
      try {
        const material = await uploadMaterial(file);
        setMaterials((prev) => [material, ...prev]);
      } catch (err) {
        setError(
          err instanceof Error
            ? `上传失败：${err.message}`
            : "上传失败，请检查服务端是否启动",
        );
      } finally {
        setUploading((value) => value - 1);
      }
    }
  };

  const handleDelete = async (material: LibraryMaterial) => {
    try {
      await deleteMaterial(material.id);
      setMaterials((prev) => prev.filter((item) => item.id !== material.id));
    } catch (err) {
      setError(err instanceof Error ? `删除失败：${err.message}` : "删除失败");
    }
  };

  const query = search.trim().toLowerCase();
  const matched = materials.filter((material) => material.name.toLowerCase().includes(query));
  const uploaded = matched.filter((material) => material.uploaded);
  const publics = matched.filter((material) => !material.uploaded);
  const total = uploaded.length + publics.length;

  return (
    <>
      <button
        type="button"
        aria-label="关闭素材库"
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default bg-ink/10 lg:hidden"
      />
      <aside
        aria-label="素材库面板"
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[420px] flex-col border-l border-line bg-canvas shadow-[0_0_60px_-20px_rgba(24,24,27,0.35)]"
      >
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
          <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3">
            <Search className="size-3.5 shrink-0 text-faint" strokeWidth={1.75} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索素材"
              aria-label="搜索素材"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-faint"
            />
          </div>
          {canManage && (
            <button
              type="button"
              onClick={() => uploadInputRef.current?.click()}
              aria-label="上传素材"
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12px] text-ink transition-colors hover:bg-surface"
            >
              <Plus className="size-3.5" strokeWidth={2} />
              <span className="hidden sm:inline">上传素材</span>
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭素材库"
            className="grid size-9 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-ink"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </header>

        <input
          ref={uploadInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            void handleFiles(event.target.files);
            event.target.value = "";
          }}
        />

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {error && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-line bg-surface px-2.5 py-2 text-[11.5px] text-danger">
              <span className="min-w-0 flex-1">{error}</span>
              <button
                type="button"
                onClick={() => setReloadKey((value) => value + 1)}
                className="shrink-0 underline underline-offset-2"
              >
                重试
              </button>
            </div>
          )}

          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-faint">
              <Loader2 className="size-4 animate-spin" strokeWidth={2} />
              加载素材库…
            </div>
          ) : total === 0 && uploading === 0 ? (
            <div className="flex h-full items-center justify-center text-[12.5px] text-faint">
              {query ? "没有匹配的素材" : "素材库还是空的"}
            </div>
          ) : (
            <>
              <div className="mb-2.5 flex items-baseline justify-between">
                <span className="text-[12.5px] font-medium text-ink">素材库</span>
                <span className="text-[10px] text-faint">{total}</span>
              </div>

              {uploaded.length > 0 && (
                <div className="mb-4 grid grid-cols-3 gap-2.5">
                  {uploaded.map((material) => (
                    <MaterialCard
                      key={material.id}
                      material={material}
                      canDelete={canManage}
                      onSelect={onSelect}
                      onDelete={(item) => void handleDelete(item)}
                    />
                  ))}
                </div>
              )}

              {uploading > 0 && (
                <div className="mb-4 flex items-center gap-2 text-[12px] text-faint">
                  <Loader2 className="size-3.5 animate-spin" strokeWidth={2} />
                  上传中…
                </div>
              )}

              <div className="mb-2.5 mt-1 flex items-baseline justify-between">
                <span className="text-[12.5px] font-medium text-ink">公共素材库</span>
                <span className="text-[10px] text-faint">{publics.length}</span>
              </div>
              <div className="grid grid-cols-3 gap-2.5">
                {publics.map((material) => (
                  <MaterialCard
                    key={material.id}
                    material={material}
                    canDelete={false}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
