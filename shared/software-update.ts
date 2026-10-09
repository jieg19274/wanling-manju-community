export type SoftwareUpdate = {
  currentVersion:string;configured:boolean;enabled:boolean;
  status:'idle'|'checking'|'downloading'|'ready'|'current'|'updated'|'error'|'rolled_back';
  message:string;availableVersion?:string;lastCheckedAt?:string;progress?:number;
};
