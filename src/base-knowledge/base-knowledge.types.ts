export interface BaseKnowledge {
  id: string;
  title: string;
  description: string;
  category: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
}
