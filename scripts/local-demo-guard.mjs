import { resolve } from "node:path";

export function assertLocalDemoEnvironment({nodeEnv,databaseUrl,storageUrl,publicUrl}){
  if(nodeEnv==="production")throw new Error("local_demo_not_allowed_in_production");
  let database,storage,app;
  try{
    database=new URL(databaseUrl);
    storage=new URL(storageUrl);
    app=new URL(publicUrl);
  }catch{
    throw new Error("local_demo_service_url_invalid");
  }
  if(database.protocol!=="postgresql:"||database.hostname!=="127.0.0.1"||database.port!=="56432"||database.pathname!=="/sloptogether"
    ||database.username!=="postgres"||database.password||database.search||database.hash
    ||storage.protocol!=="http:"||storage.hostname!=="127.0.0.1"||storage.port!=="9000"||storage.pathname!=="/"
    ||storage.username||storage.password||storage.search||storage.hash
    ||app.origin!=="http://localhost:3000"||app.pathname!=="/"||app.username||app.password||app.search||app.hash){
    throw new Error("local_demo_requires_exact_loopback_services");
  }
}

export function assertLocalDemoDatabase(identity){
  const databaseName=identity?.databaseName??identity?.database_name;
  const dataDirectory=identity?.dataDirectory??identity?.data_directory;
  const serverAddress=identity?.serverAddress??identity?.server_address;
  const serverPort=identity?.serverPort??identity?.server_port;
  if(databaseName!=="sloptogether"||dataDirectory!=="/tmp/sloptogether-pg"
    ||serverAddress!=="127.0.0.1"||Number(serverPort)!==56432
    ||resolve(dataDirectory)!==resolve("/tmp/sloptogether-pg"))
    throw new Error("local_demo_database_identity_not_allowed");
}
