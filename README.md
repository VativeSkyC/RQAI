
# AI Relationship Management System

A powerful web application that automates professional relationship building through AI-powered calls and personalized data collection.

## Overview

This system combines Twilio for telephony, ElevenLabs for AI conversation, and a custom Node.js backend to provide a seamless customer relationship management experience. The application conducts professional intake interviews with your contacts automatically, collecting valuable information like communication preferences, goals, and expectations.

## Features

- **User Authentication**: Secure login and registration system
- **Contact Management**: Add and manage professional contacts
- **Automated Outreach**: Send automated SMS invitations to contacts
- **AI-Powered Intake**: ElevenLabs AI agent conducts professional intake calls
- **Personalized Conversations**: Dynamic conversations based on contact information
- **Data Collection**: Structured storage of communication preferences, goals, and values
- **Dashboard Interface**: View and manage all relationship insights in one place

## Technical Stack

- **Backend**: Node.js + Express
- **Database**: PostgreSQL
- **Authentication**: JWT (JSON Web Tokens)
- **External APIs**:
  - Twilio for SMS and telephony
  - ElevenLabs for AI voice agent
  - OpenAI for transcript analysis (optional)
- **Hosting**: Replit with Ngrok for tunneling

## Getting Started

### Prerequisites

1. Replit account
2. Twilio account with a phone number
3. ElevenLabs account
4. PostgreSQL database

### Environment Variables

Set up the following environment variables in the Replit Secrets tool:

- `JWT_SECRET`: Secret key for JWT authentication
- `TWILIO_ACCOUNT_SID`: Your Twilio account SID
- `TWILIO_AUTH_TOKEN`: Your Twilio authentication token
- `TWILIO_PHONE_NUMBER`: Your Twilio phone number
- `DATABASE_URL`: PostgreSQL connection string
- `ELEVENLABS_SECRET`: Your ElevenLabs API key
- `NGROK_AUTH_TOKEN`: (Optional) For custom ngrok domain
- `NGROK_SUBDOMAIN`: (Optional) For custom ngrok subdomain

### Installation

1. Clone this repository to your Replit workspace
2. Install dependencies: `npm install`
3. Set up environment variables in the Secrets tool
4. Start the server: Click the Run button

### Setting Up Webhooks

1. Once the application is running, you'll see Ngrok URLs in the console
2. Set up your Twilio webhook: `https://your-ngrok-url.ngrok.io/voice`
3. Set up your ElevenLabs webhook: `https://your-ngrok-url.ngrok.io/receive-data`

## Usage Flow

1. **Register & Login**: Create an account and log in to the dashboard
2. **Add Contacts**: Enter contact details including phone number
3. **Automatic Outreach**: The system sends an SMS invitation
4. **AI Intake Call**: When the contact calls your Twilio number:
   - The system identifies the caller using call_sid and phone number
   - ElevenLabs AI conducts a personalized intake interview
   - The contact responds to questions about preferences and goals
5. **Data Processing**: After the call:
   - All responses are stored in the database
   - Data is linked to the correct contact record
6. **Review Insights**: Access the dashboard to review collected information

## Database Schema

The application uses several key tables:

- `users`: Store registered users
- `contacts`: Store contact information
- `temp_calls`: Track active calls with call_sid and phone_number
- `intake_responses`: Store structured data from intake calls
- `call_log`: Track call history for debugging

## Troubleshooting

- **Database Connection Issues**: Check your DATABASE_URL in Secrets
- **Ngrok Tunnel Errors**: Make sure you don't have multiple tunnels running
- **Webhook Failures**: Verify your Twilio and ElevenLabs webhook URLs

## Security Notes

- All authentication is handled via JWT tokens
- Sensitive information is stored in environment variables
- Database connections are secured with parameterized queries
- Phone numbers are validated before processing

