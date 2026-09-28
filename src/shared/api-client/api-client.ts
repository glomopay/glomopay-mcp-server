// TODO: Add Types support using Generics
// TODO: Request level log toggle
// TODO: Have own config, do not extend axios
// TODO: Constructor should take anything that extends our own config

import axios, { type AxiosInstance, type AxiosRequestConfig, AxiosError } from 'axios';
import { ZodSchema } from 'zod';

import { convertToCamelCase, convertToSnakeCase } from '@/shared/case-converter/case-converter.module';
import { logger } from '@/shared/logger/logger.module';

/**
 * Custom error class for API errors.
 * Includes additional context such as HTTP status code and error data.
 */
export class ApiError extends Error {
  public statusCode?: number;
  public data?: unknown;
  /** Transport error code (e.g. ETIMEDOUT) when no response arrived. */
  public code?: string;
  public headers?: Record<string, unknown>;

  constructor(message: string, statusCode?: number, data?: unknown, meta: { code?: string; headers?: Record<string, unknown> } = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.data = data;
    this.code = meta.code;
    this.headers = meta.headers;
  }
}

export interface IApiResponse {
  status: number;
  headers: Record<string, unknown>;
  data: unknown;
}

export type THttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A type alias for a custom error handler function.
 */
type TErrorHandler = (error: AxiosError) => void;

type TZodSchemaParam = ZodSchema | undefined | null;

/**
 * Extended interface for custom configuration options.
 */
interface IApiClientConfig extends AxiosRequestConfig {
  enableCaseConversion?: boolean;
}

/**
 * ApiClient provides a unified interface over the axios HTTP client
 * It centralizes error handling, supports custom error handlers
 * Enables optional response validation using Zod
 * Optionally converts request and response payloads between camelCase and snake_case
 * Logs request and response data for debugging
 */
export class ApiClient {
  private axiosInstance: AxiosInstance;
  private customErrorHandlers: { [status: number]: TErrorHandler };
  private enableCaseConversion: boolean;

  constructor(config: IApiClientConfig = {}, customErrorHandlers: { [statusCode: number]: TErrorHandler } = {}) {
    this.axiosInstance = axios.create(config);
    this.customErrorHandlers = customErrorHandlers;
    this.enableCaseConversion = config.enableCaseConversion || false;

    // Response interceptor for centralized error handling.
    this.axiosInstance.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response) {
          const statusCode = error.response.status;
          const errorData = error.response.data;
          const message =
            (errorData as { message?: string; error?: string } | undefined)?.message ||
            (errorData as { message?: string; error?: string } | undefined)?.error ||
            `Request failed with status ${statusCode}`;

          // Invoke custom error handler for the status code, if available.
          if (this.customErrorHandlers[statusCode]) this.customErrorHandlers[statusCode](error);

          return Promise.reject(new ApiError(message, statusCode, errorData, { headers: { ...error.response.headers } }));
        } else {
          logger.error('glomo API network error', { component: 'api-client', transportErrorCode: error.code, message: error.message });
          return Promise.reject(new ApiError(error.message, undefined, undefined, { code: error.code }));
        }
      },
    );
  }

  /**
   * Validates the response data against an optional Zod schema.
   * @param data - The response data.
   * @param schema - Optional Zod schema for validation.
   * @param status - HTTP status code for context.
   * @returns Validated data.
   * @throws ApiError if validation fails.
   */
  private validateResponse(data: unknown, schema: ZodSchema) {
    const result = schema.safeParse(data);
    if (!result.success) throw new ApiError(`Response validation error: ${JSON.stringify(result.error.errors)}`, 500, data);
    return result.data;
  }

  /**
   * General method for making API requests.
   * @param method - HTTP method ('get', 'post', 'put', 'delete').
   * @param url - Endpoint URL.
   * @param data - Request payload (if applicable).
   * @param config - Additional Axios configuration.
   * @param schema - Optional Zod schema for response validation.
   * @returns The validated response data.
   */
  async request(method: THttpMethod, url: string, body?: unknown, schema?: TZodSchemaParam, config: AxiosRequestConfig = {}) {
    const { data } = await this.requestWithResponse(method, url, body, schema, config);
    return data;
  }

  /** Like `request`, but also returns the HTTP status and response headers. */
  async requestWithResponse(
    method: THttpMethod,
    url: string,
    body?: unknown,
    schema?: TZodSchemaParam,
    config: AxiosRequestConfig = {},
  ): Promise<IApiResponse> {
    if (this.enableCaseConversion) {
      if (body && typeof body === 'object') body = convertToSnakeCase(body);
      if (config.params && typeof config.params === 'object') config.params = convertToSnakeCase(config.params);
    }
    const response = await this.axiosInstance.request({
      method,
      url,
      data: body,
      ...config,
    });
    let data = response.data;
    data = this.enableCaseConversion && typeof data === 'object' ? convertToCamelCase(data) : data;
    return { status: response.status, headers: { ...response.headers }, data: schema ? this.validateResponse(data, schema) : data };
  }

  async get(url: string, params?: Record<string, unknown>, schema?: TZodSchemaParam, config: AxiosRequestConfig = {}) {
    return this.request('GET', url, undefined, schema, { ...config, params });
  }

  async post(url: string, body: unknown = {}, schema?: TZodSchemaParam, config: AxiosRequestConfig = {}) {
    return this.request('POST', url, body, schema, config);
  }

  async put(url: string, body: unknown = {}, schema?: TZodSchemaParam, config: AxiosRequestConfig = {}) {
    return this.request('PUT', url, body, schema, config);
  }

  async patch(url: string, body: unknown = {}, schema?: TZodSchemaParam, config: AxiosRequestConfig = {}) {
    return this.request('PATCH', url, body, schema, config);
  }

  async delete(url: string, schema?: TZodSchemaParam, config: AxiosRequestConfig = {}) {
    return this.request('DELETE', url, undefined, schema, config);
  }
}
