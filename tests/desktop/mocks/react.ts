export const useState = <T,>(init: T) => [init, () => {}] as const
export const useEffect = (fn: () => unknown) => { fn() }
