import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";

const mocks=vi.hoisted(()=>({query:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./db",()=>({query:mocks.query}));

import { screenPromptAndImages } from "./preflight";

const input={channelId:"123",prompt:"A gentle cartoon fox waves at the viewer.",images:[{bytes:Buffer.from("synthetic-image"),contentType:"image/png"}]};

beforeEach(()=>{
  vi.resetAllMocks();
  vi.stubEnv("SLOPTOGETHER_OPENAI_MODERATION_KEY","test-moderation-key");
  vi.stubEnv("OPENAI_API_KEY","");
  mocks.query.mockResolvedValueOnce({rows:[],rowCount:0}).mockResolvedValueOnce({rows:[],rowCount:1});
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});

describe("OpenAI moderation preflight",()=>{
  it("uses the dedicated moderation credential for prompt plus image and records evidence",async()=>{
    const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({id:"mod-test",results:[{
      flagged:false,categories:{violence:false},category_applied_input_types:{violence:["text","image"]},
    }]}),{status:200,headers:{"Content-Type":"application/json"}}));
    vi.stubGlobal("fetch",fetch);

    await expect(screenPromptAndImages(input)).resolves.toMatchObject({decision:"clear",moderationId:"mod-test",model:"omni-moderation-latest"});
    const [url,request]=fetch.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/moderations");
    expect((request as RequestInit).headers).toMatchObject({Authorization:"Bearer test-moderation-key"});
    const body=JSON.parse(String((request as RequestInit).body));
    expect(body.input).toHaveLength(2);
    expect(body.input[0]).toMatchObject({type:"text",text:input.prompt});
    expect(body.input[1].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[1]![0]).toContain("INSERT INTO sloptogether.input_screens");
  });

  it("fails closed when neither the moderation key nor a clear cache entry exists",async()=>{
    vi.stubEnv("SLOPTOGETHER_OPENAI_MODERATION_KEY","");
    mocks.query.mockReset();
    mocks.query.mockResolvedValue({rows:[],rowCount:0});
    const fetch=vi.fn();vi.stubGlobal("fetch",fetch);

    await expect(screenPromptAndImages(input)).rejects.toMatchObject({status:503,code:"input_moderation_not_configured"});
    expect(fetch).not.toHaveBeenCalled();
  });

  it("holds flagged content and persists the classifier categories",async()=>{
    mocks.query.mockReset();
    mocks.query.mockResolvedValueOnce({rows:[],rowCount:0}).mockResolvedValueOnce({rows:[],rowCount:1});
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({id:"mod-held",results:[{
      flagged:true,categories:{violence:true},category_applied_input_types:{violence:["text"]},
    }]}),{status:200})));

    await expect(screenPromptAndImages(input)).resolves.toMatchObject({decision:"held",categories:{violence:true}});
    expect(mocks.query.mock.calls[1]![1]).toContainEqual(expect.stringContaining("mod-held"));
  });

  it("screens each frame separately because Moderations accepts one image per request",async()=>{
    const second={...input,images:[...input.images,{bytes:Buffer.from("second-image"),contentType:"image/png"}]};
    vi.stubGlobal("fetch",vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({id:"start",results:[{flagged:false,categories:{violence:false},category_applied_input_types:{violence:["image"]}}]}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({id:"end",results:[{flagged:false,categories:{violence:false},category_applied_input_types:{violence:["image"]}}]}),{status:200})));
    await expect(screenPromptAndImages(second)).resolves.toMatchObject({decision:"clear",moderationId:"start,end"});
    expect(fetch).toHaveBeenCalledTimes(2);
    for(const [,request] of vi.mocked(fetch).mock.calls){
      const body=JSON.parse(String((request as RequestInit).body));
      expect(body.input.filter((part:{type:string})=>part.type==="image_url")).toHaveLength(1);
    }
  });
});
