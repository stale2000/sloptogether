const clipsDatabaseUsers:Record<string,string>={
  "db.lkyaaokrpbqucjrnhrps.supabase.co":"sloptogether_app",
  "aws-1-us-east-2.pooler.supabase.com":"sloptogether_app.lkyaaokrpbqucjrnhrps",
};

export function isClipsDatabase(url:URL):boolean{
  return Object.hasOwn(clipsDatabaseUsers,url.hostname.toLowerCase());
}

export function hasScopedClipsDatabaseUser(url:URL):boolean{
  return clipsDatabaseUsers[url.hostname.toLowerCase()]===url.username;
}
