export type LibraryMaterial = {
  id: string;
  name: string;
  url: string;
  mimeType: string;
  width: number;
  height: number;
  /** 用户自己上传的素材，可以删除；公共素材只读。 */
  uploaded?: boolean;
};

/** 公共素材库的 mock 数据：公网访问时所有人看到同一组，后续换真实接口。 */
export const PUBLIC_MATERIALS: LibraryMaterial[] = [
  {
    id: "poster-2",
    name: "海报 02 · FORM",
    url: "/mock/poster-2.svg",
    mimeType: "image/svg+xml",
    width: 1024,
    height: 1536,
  },
  {
    id: "poster-3",
    name: "海报 03 · NIGHT",
    url: "/mock/poster-3.svg",
    mimeType: "image/svg+xml",
    width: 1024,
    height: 1536,
  },
  {
    id: "poster-4",
    name: "海报 04 · STUDIO",
    url: "/mock/poster-4.svg",
    mimeType: "image/svg+xml",
    width: 1024,
    height: 1536,
  },
  {
    id: "insp-1",
    name: "灵感 01 · 编辑感",
    url: "/mock/insp-1.svg",
    mimeType: "image/svg+xml",
    width: 800,
    height: 600,
  },
  {
    id: "insp-2",
    name: "灵感 02 · 网格",
    url: "/mock/insp-2.svg",
    mimeType: "image/svg+xml",
    width: 800,
    height: 600,
  },
  {
    id: "insp-3",
    name: "灵感 03 · 大字",
    url: "/mock/insp-3.svg",
    mimeType: "image/svg+xml",
    width: 800,
    height: 600,
  },
  {
    id: "insp-4",
    name: "灵感 04 · 空间",
    url: "/mock/insp-4.svg",
    mimeType: "image/svg+xml",
    width: 800,
    height: 600,
  },
];
