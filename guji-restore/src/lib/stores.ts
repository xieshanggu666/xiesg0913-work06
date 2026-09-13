import { writable } from 'svelte/store';
import type {
  Comment,
  Folio,
  ID,
  Layer,
  Material,
  Project,
  RestorationStep,
  Sample,
  Shape
} from '@shared/types';
import type { MaterialBatchWithQty, StepIssueRow } from '@shared/protocol';

export type ViewKey =
  | 'annotate'
  | 'samples'
  | 'materials'
  | 'inventory'
  | 'steps'
  | 'compare'
  | 'archive'
  | 'dashboard';

export const currentView = writable<ViewKey>('annotate');
export const operator = writable<string>(localStorage.getItem('guji-operator') || '修复师');
operator.subscribe((v) => localStorage.setItem('guji-operator', v));

export const projects = writable<Project[]>([]);
export const currentProjectId = writable<ID | null>(localStorage.getItem('guji-project') || null);
currentProjectId.subscribe((v) => {
  if (v) localStorage.setItem('guji-project', v);
});

export const folios = writable<Folio[]>([]);
export const currentFolioId = writable<ID | null>(null);
export const layers = writable<Layer[]>([]);
export const shapes = writable<Shape[]>([]);
export const selectedShapeId = writable<ID | null>(null);
export const activeLayerId = writable<ID | null>(null);

export const samples = writable<Sample[]>([]);
export const materials = writable<Material[]>([]);
export const recommendSampleId = writable<ID | null>(null);
export const steps = writable<RestorationStep[]>([]);
export const comments = writable<Comment[]>([]);

/** 材料领用（批次追溯） */
export const batches = writable<MaterialBatchWithQty[]>([]);
/** 某道工序的领料记录缓存：stepId → 行（含已退/未退） */
export const stepIssuesMap = writable<Record<string, StepIssueRow[]>>({});
/** 从材料库“登记批次/看批次”带入的材料筛选（跨视图） */
export const inventoryMaterialFilter = writable<ID | null>(null);
/** 新增批次时预选的材料（从材料库“登记批次”带入） */
export const inventoryPrefillMaterial = writable<ID | null>(null);

export const busy = writable(false);
