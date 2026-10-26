"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { Button, Input, Alert } from "@/components/ui";
import { useRateLimit } from "@/hooks/useRateLimit";

export default function LoginPage() {
  const router = useRouter();
  const { login, loading, error } = useAuth();
  const [formData, setFormData] = useState({
    email: "",
    password: "",
  });
  const [rateLimitMessage, setRateLimitMessage] = useState("");

  // Client-side mirror of the server's LOGIN policy. `guard()` refuses the
  // request locally; `handleError()` folds a real server 429 back in so the
  // countdown reflects the server's Retry-After.
  const limiter = useRateLimit("login");

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setRateLimitMessage("");

    // Pre-flight check only: the axios interceptor is the single place that
    // consumes a local token, so we peek here (`consumeToken: false`) to render
    // an immediate message without double-counting the attempt.
    const verdict = limiter.guard({ consumeToken: false });
    if (!verdict.allowed) {
      setRateLimitMessage(verdict.message);
      return;
    }

    try {
      await login(formData.email, formData.password);
      // A successful login clears the local attempt counter.
      limiter.reset();
      router.push("/dashboard");
    } catch (err) {
      // A rejection raised by the local limiter (axios request interceptor).
      if (err?.isClientRateLimited) {
        setRateLimitMessage(err.message);
        return;
      }

      // Distinguish "the server rate-limited us" from a genuine auth failure so
      // the user gets an accurate, actionable message.
      if (limiter.handleError(err)) {
        setRateLimitMessage(
          err.response?.data?.error ||
            `Too many login attempts. Please wait ${limiter.waitLabel || "a moment"}.`,
        );
        return;
      }
      // Any other error is already handled by AuthContext.
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 bg-gradient-to-br from-slate-900 via-slate-800 to-blue-900 py-12 px-4 sm:px-6 lg:px-8">
      <div className="w-full max-w-md space-y-6 animate-slide-up">
        <div className="text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-blue-600 text-lg font-bold text-white shadow-lg">
            B
          </div>
          <h2 className="text-2xl font-bold tracking-tight text-white">
            Campus Bus Scheduling
          </h2>
          <p className="mt-1.5 text-sm text-slate-400">Sign in to your account</p>
        </div>

        <div className="rounded-2xl bg-slate-900 p-8 shadow-2xl ring-1 ring-slate-800">
          {error && !rateLimitMessage && (
            <Alert variant="danger" className="mb-4">
              {error}
            </Alert>
          )}

          {(rateLimitMessage || limiter.isLimited) && (
            <Alert variant="warning" className="mb-4">
              {rateLimitMessage ||
                `Too many attempts. Please wait ${limiter.waitLabel} before trying again.`}
            </Alert>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Email Address"
              name="email"
              type="email"
              value={formData.email}
              onChange={handleChange}
              placeholder="Enter your email"
              required
            />

            <Input
              label="Password"
              name="password"
              type="password"
              value={formData.password}
              onChange={handleChange}
              placeholder="Enter your password"
              required
            />

            <Button
              type="submit"
              variant="primary"
              className="w-full"
              loading={loading}
              disabled={limiter.isLimited}
            >
              {limiter.isLimited ? `Try again in ${limiter.waitLabel}` : "Sign In"}
            </Button>
          </form>

          <div className="mt-6 text-center">
            <p className="text-sm text-slate-400">
              Don't have an account?{" "}
              <Link
                href="/register"
                className="font-medium text-blue-400 hover:text-blue-300"
              >
                Register here
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

