// User API — with pagination support

export interface User {
  id: number;
  name: string;
  email: string;
}

interface UserStore {
  getAllUsers(): User[];
}

export interface PaginationOptions {
  page?: number;
  pageSize?: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export function listUsers(store: UserStore, options?: PaginationOptions): PaginatedResponse<User> {
  const allUsers = store.getAllUsers();
  const total = allUsers.length;

  const page = Math.max(1, options?.page ?? DEFAULT_PAGE);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, options?.pageSize ?? DEFAULT_PAGE_SIZE));
  const totalPages = Math.ceil(total / pageSize);

  const startIndex = (page - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  const items = allUsers.slice(startIndex, endIndex);

  return { items, total, page, pageSize, totalPages };
}
