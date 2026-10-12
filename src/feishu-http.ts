import { Client, defaultHttpInstance } from '@larksuiteoapi/node-sdk';

type FeishuHttpClient = NonNullable<ConstructorParameters<typeof Client>[0]['httpInstance']>
  & Pick<typeof defaultHttpInstance, 'interceptors' | 'defaults'>;

/** A private SDK transport with deadlines for token, REST and streaming I/O. */
export function createFeishuHttpClient(timeoutMs = 30_000): FeishuHttpClient {
  const client = defaultHttpInstance.create({ timeout: timeoutMs });
  client.interceptors.request.use(request => {
    const deadline = AbortSignal.timeout(request.timeout || timeoutMs);
    request.signal = request.signal
      ? AbortSignal.any([request.signal as AbortSignal, deadline])
      : deadline;
    return request;
  });
  // Axios.create does not inherit the SDK's response interceptor. Preserve its
  // unwrapped payload and download-header conventions on this private client.
  client.interceptors.response.use(response => {
    if ((response.config as { $return_headers?: boolean }).$return_headers) {
      return { data: response.data, headers: response.headers };
    }
    return response.data;
  });
  // The interceptor changes AxiosResponse<R> into the SDK's Promise<R>.
  return client as unknown as FeishuHttpClient;
}
