planing llm should output this schmea 


current stage use JSON, in later we need design syntax. 

```ts 
type Task = {
  id: number,
  loc: Loc,
  parent: number,
  deps: number[]
}

type Loc = {
  path: string, 
  symbol: string, 
  kind : "type" | "namespace" // ...
}

type execute_list = number[]

type LLM_Output = {
  tasks : Task[],
  todo: number[],
  status: Map<number, Status>
}

type Status = "done" | "todo" | "in-progree" // ...
```
