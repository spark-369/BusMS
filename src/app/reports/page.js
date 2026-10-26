"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useAuth } from "@/context/AuthContext";
import { Card, Button, Badge, LoadingSpinner, Select } from "@/components/ui";
import { reportService } from "@/services/reportService";
import { FiDownload, FiFileText, FiCalendar } from "react-icons/fi";

export default function ReportsPage() {
  const { isAdmin } = useAuth();
  const pathname = usePathname();
  const [loading, setLoading] = useState(false);
  const [reportType, setReportType] = useState("daily-summary");
  const [reportData, setReportData] = useState(null);

  useEffect(() => {
    if (isAdmin) {
      fetchReport();
    }
    // Re-runs on each sidebar tab switch (and when the report type changes).
  }, [reportType, pathname, isAdmin]);

  const fetchReport = async () => {
    try {
      setLoading(true);
      let data;

      switch (reportType) {
        case "daily-summary":
          data = await reportService.getDailySummary();
          break;
        case "bus-usage":
          data = await reportService.getBusUsage();
          break;
        case "driver-performance":
          data = await reportService.getDriverPerformance();
          break;
        case "fuel-consumption":
          data = await reportService.getFuelConsumption();
          break;
        default:
          data = await reportService.getDashboard();
      }

      setReportData(data);
    } catch (error) {
      console.error("Error fetching report:", error);
    } finally {
      setLoading(false);
    }
  };

  if (!isAdmin) {
    return (
      <DashboardLayout>
        <div className="text-center py-12">
          <p className="text-slate-400">Access denied. Admin only.</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex justify-between items-center">
          <h1 className="text-2xl font-bold text-slate-100">Reports</h1>
        </div>

        {/* Filters */}
        <div className="bg-slate-900 rounded-lg shadow p-6 ring-1 ring-slate-800">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label="Report Type"
              value={reportType}
              onChange={(e) => setReportType(e.target.value)}
              options={[
                { value: "daily-summary", label: "Daily Summary" },
                { value: "bus-usage", label: "Bus Usage Report" },
                {
                  value: "driver-performance",
                  label: "Driver Performance Report",
                },
                {
                  value: "fuel-consumption",
                  label: "Fuel Consumption Report",
                },
              ]}
            />
          </div>
        </div>

        {/* Report Data */}
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <LoadingSpinner size="lg" />
          </div>
        ) : reportData ? (
          <div className="space-y-6">
            {/* Overview Cards */}
            {reportData.overview && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                {Object.entries(reportData.overview).map(([key, value]) => (
                  <Card key={key} className="p-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-slate-400 capitalize">
                          {key.replace(/([A-Z])/g, " $1")}
                        </p>
                        <p className="text-2xl font-bold text-slate-100 mt-1">
                          {typeof value === "number"
                            ? value.toLocaleString()
                            : value}
                        </p>
                      </div>
                      <div className="p-3 bg-blue-500/15 rounded-full">
                        <FiFileText className="text-blue-400" size={24} />
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}

            {/* Daily Summary */}
            {reportData.date && (
              <Card className="p-6">
                <h3 className="text-lg font-semibold mb-4">
                  Daily Summary - {reportData.date}
                </h3>
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div>
                    <p className="text-3xl font-bold text-blue-400">
                      {reportData.totalTrips || 0}
                    </p>
                    <p className="text-sm text-slate-400">Total Trips</p>
                  </div>
                  <div>
                    <p className="text-3xl font-bold text-emerald-400">
                      {reportData.completedTrips || 0}
                    </p>
                    <p className="text-sm text-slate-400">Completed</p>
                  </div>
                  <div>
                    <p className="text-3xl font-bold text-red-400">
                      {reportData.cancelledTrips || 0}
                    </p>
                    <p className="text-sm text-slate-400">Cancelled</p>
                  </div>
                </div>
              </Card>
            )}

            {/* Bus Usage */}
            {reportData.buses && (
              <div className="bg-slate-900 rounded-lg shadow overflow-hidden ring-1 ring-slate-800">
                <div className="px-6 py-4 border-b border-slate-800">
                  <h2 className="text-lg font-semibold text-slate-100">Bus Usage</h2>
                </div>
                <table className="min-w-full divide-y divide-slate-800">
                  <thead className="bg-slate-950/60">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-slate-400 uppercase">
                        Bus Number
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-slate-400 uppercase">
                        Capacity
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-slate-400 uppercase">
                        Status
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-slate-400 uppercase">
                        Total Trips
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-slate-400 uppercase">
                        Total Bookings
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {reportData.buses.map((bus) => (
                      <tr key={bus.id} className="hover:bg-slate-800/60">
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-100">
                          {bus.busNumber}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-400">
                          {bus.capacity}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <Badge
                            variant={
                              bus.status === "ACTIVE" ? "success" : "default"
                            }
                          >
                            {bus.status}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-400">
                          {bus.totalTrips}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-400">
                          {bus.totalBookings}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Driver Performance */}
            {reportData.drivers && (
              <div className="bg-slate-900 rounded-lg shadow overflow-hidden ring-1 ring-slate-800">
                <div className="px-6 py-4 border-b border-slate-800">
                  <h2 className="text-lg font-semibold text-slate-100">Driver Performance</h2>
                </div>
                <table className="min-w-full divide-y divide-slate-800">
                  <thead className="bg-slate-950/60">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-slate-400 uppercase">
                        Name
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-slate-400 uppercase">
                        Email
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-slate-400 uppercase">
                        Phone
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-slate-400 uppercase">
                        Total Trips
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-slate-400 uppercase">
                        Active
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {reportData.drivers.map((driver) => (
                      <tr key={driver.id} className="hover:bg-slate-800/60">
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-100">
                          {driver.name}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-400">
                          {driver.email}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-400">
                          {driver.phone || "N/A"}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-400">
                          {driver.totalTrips}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <Badge
                            variant={driver.isAvailable ? "success" : "default"}
                          >
                            {driver.isAvailable ? "Yes" : "No"}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Fuel Consumption */}
            {reportData.records && (
              <div className="space-y-4">
                <Card className="p-6">
                  <h3 className="text-lg font-semibold mb-4">Fuel Summary</h3>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div>
                      <p className="text-2xl font-bold text-blue-400">
                        {reportData.summary?.totalLiters?.toFixed(2) || 0}L
                      </p>
                      <p className="text-sm text-slate-400">Total Liters</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-emerald-400">
                        ${reportData.summary?.totalCost?.toFixed(2) || 0}
                      </p>
                      <p className="text-sm text-slate-400">Total Cost</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-purple-400">
                        $
                        {reportData.summary?.averagePricePerLiter?.toFixed(2) ||
                          0}
                      </p>
                      <p className="text-sm text-slate-400">Avg Price/Liter</p>
                    </div>
                  </div>
                </Card>

                <div className="bg-slate-900 rounded-lg shadow overflow-hidden ring-1 ring-slate-800">
                  <table className="min-w-full divide-y divide-slate-800">
                    <thead className="bg-slate-950/60">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-slate-400 uppercase">
                          Date
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-slate-400 uppercase">
                          Bus
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-slate-400 uppercase">
                          Amount (L)
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-slate-400 uppercase">
                          Cost
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {reportData.records.slice(0, 10).map((record, index) => (
                        <tr key={index} className="hover:bg-slate-800/60">
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-400">
                            {new Date(record.date).toLocaleDateString()}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-100">
                            {record.bus?.busNumber}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-400">
                            {record.amount}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-400">
                            ${record.cost}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Passenger Attendance */}
            {reportData.stats && (
              <div className="space-y-4">
                <Card className="p-6">
                  <h3 className="text-lg font-semibold mb-4">
                    Attendance Summary
                  </h3>
                  {/* Responsive: 2 columns on phones, 4 from `sm` up. */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
                    <div>
                      <p className="text-2xl font-bold text-blue-400">
                        {reportData.stats.total ?? 0}
                      </p>
                      <p className="text-sm text-slate-400">Total</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-emerald-400">
                        {reportData.stats.present ?? 0}
                      </p>
                      <p className="text-sm text-slate-400">Present</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-red-400">
                        {reportData.stats.absent ?? 0}
                      </p>
                      <p className="text-sm text-slate-400">Absent</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-yellow-400">
                        {/* `Number(...)` guards against a null/undefined or a
                            string value: calling .toFixed() directly on those
                            throws and would blank the whole card. */}
                        {Number(reportData.stats.attendanceRate ?? 0).toFixed(1)}%
                      </p>
                      <p className="text-sm text-slate-400">Attendance Rate</p>
                    </div>
                  </div>

                  {reportData.stats.total === 0 && (
                    <p className="mt-4 text-sm text-slate-400 text-center">
                      No bookings for today. Attendance is recorded on the
                      Bookings page when a passenger is marked as attended.
                    </p>
                  )}
                </Card>
              </div>
            )}
          </div>
        ) : (
          <div className="text-center py-12">
            <FiFileText className="mx-auto text-slate-500" size={48} />
            <p className="mt-4 text-slate-400">No report data available</p>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
