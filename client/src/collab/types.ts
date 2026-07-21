export type Identity = {
  id: string;
  name: string;
  color: string;
};

export type CollabUser = {
  id: string;
  name: string;
  color: string;
};

export type CollabPresence = {
  clientId: number;
  user: CollabUser;
};
