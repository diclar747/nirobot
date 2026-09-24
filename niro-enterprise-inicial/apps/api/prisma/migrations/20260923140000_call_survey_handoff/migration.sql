ALTER TABLE "CallSurveyOption" ADD COLUMN "departmentId" TEXT;
ALTER TABLE "CallSurveyOption" ADD COLUMN "userId" TEXT;
ALTER TABLE "CallSurveyOption" ADD CONSTRAINT "CallSurveyOption_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallSurveyOption" ADD CONSTRAINT "CallSurveyOption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
