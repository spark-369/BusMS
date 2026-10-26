"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { Button, Input, Select, Alert } from "@/components/ui";
import { useRateLimit } from "@/hooks/useRateLimit";

export default function RegisterPage() {
  const router = useRouter();
  const { register, loading, error } = useAuth();
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
    phone: "",
    role: "PASSENGER",
    passengerId: "",
    licenseNumber: "",
  });
  const [validationError, setValidationError] = useState("");
  const [rateLimitMessage, setRateLimitMessage] = useState("");

  const limiter = useRateLimit("register");

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setValidationError("");
    setRateLimitMessage("");

    if (formData.password !== formData.confirmPassword) {
      setValidationError("Passwords do not match");
      return;
    }

    if (formData.password.length < 6) {
      setValidationError("Password must be at least 6 characters");
      return;
    }

    // Pre-flight check only: the axios interceptor is the single place that
    // consumes a local token, so we peek here (`consumeToken: false`) to render
    // an immediate message without double-counting the attempt.
    const verdict = limiter.guard({ consumeToken: false });
    if (!verdict.allowed) {
      setRateLimitMessage(verdict.message);
      return;
    }

    try {
      const userData = {
        name: formData.name,
        email: formData.email,
        password: formData.password,
        phone: formData.phone,
        role: formData.role,
      };

      if (formData.role === "PASSENGER" && formData.passengerId) {
        userData.passengerId = formData.passengerId;
      }

      if (formData.role === "DRIVER" && formData.licenseNumber) {
        userData.licenseNumber = formData.licenseNumber;
      }

      await register(userData);
      limiter.reset();
      router.push("/dashboard");
    } catch (err) {
      // A rejection raised by the local limiter (axios request interceptor).
      if (err?.isClientRateLimited) {
        setRateLimitMessage(err.message);
        return;
      }

      if (limiter.handleError(err)) {
        setRateLimitMessage(
          err.response?.data?.error ||
            `Too many registration attempts. Please wait ${limiter.waitLabel || "a moment"}.`,
        );
        return;
      }
      // Error is handled by AuthContext
    }
  };


  const roleOptions = [
    { value: "PASSENGER", label: "Passenger" },
    { value: "DRIVER", label: "Driver" },
  ];

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
          <p className="mt-1.5 text-sm text-slate-400">Create your account</p>
        </div>

        <div className="rounded-2xl bg-slate-900 p-8 shadow-2xl ring-1 ring-slate-800">
          {((error && !rateLimitMessage) || validationError) && (
            <Alert variant="danger" className="mb-4">
              {validationError || error}
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
              label="Full Name"
              name="name"
              type="text"
              value={formData.name}
              onChange={handleChange}
              placeholder="Enter your full name"
              required
            />

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
              label="Phone Number"
              name="phone"
              type="tel"
              value={formData.phone}
              onChange={handleChange}
              placeholder="Enter your phone number"
            />

            <Select
              label="Role"
              name="role"
              value={formData.role}
              onChange={handleChange}
              options={roleOptions}
              required
            />

            {formData.role === "PASSENGER" && (
              <Input
                label="Passenger ID"
                name="passengerId"
                type="text"
                value={formData.passengerId}
                onChange={handleChange}
                placeholder="Enter your passenger ID"
                required
              />
            )}

            {formData.role === "DRIVER" && (
              <Input
                label="License Number"
                name="licenseNumber"
                type="text"
                value={formData.licenseNumber}
                onChange={handleChange}
                placeholder="Enter your license number"
                required
              />
            )}

            <Input
              label="Password"
              name="password"
              type="password"
              value={formData.password}
              onChange={handleChange}
              placeholder="Create a password"
              required
            />

            <Input
              label="Confirm Password"
              name="confirmPassword"
              type="password"
              value={formData.confirmPassword}
              onChange={handleChange}
              placeholder="Confirm your password"
              required
            />

            <Button
              type="submit"
              variant="primary"
              className="w-full"
              loading={loading}
              disabled={limiter.isLimited}
            >
              {limiter.isLimited ? `Try again in ${limiter.waitLabel}` : "Register"}
            </Button>
          </form>

          <div className="mt-6 text-center">
            <p className="text-sm text-slate-400">
              Already have an account?{" "}
              <Link
                href="/login"
                className="font-medium text-blue-400 hover:text-blue-300"
              >
                Sign in here
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
