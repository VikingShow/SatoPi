// User API — currently returns all users, needs pagination

export interface User {
  id: number;
  name: string;
  email: string;
}

interface UserStore {
  getAllUsers(): User[];
}

export function listUsers(store: UserStore): User[] {
  return store.getAllUsers();
}
