import type { Obj } from '../utils/runtime';

export interface ResponsesItem extends Obj {
  id: string;
  type: string;
  status?: string;
}

export interface ResponsesEvent extends Obj {
  type: string;
}
